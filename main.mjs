import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import express from 'express';
import fileUpload from 'express-fileupload';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, readdirSync } from 'fs';
import { randomInt } from 'crypto';
import { Extension, HPacket, HDirection } from 'gnode-api';
import pkg from '@tonejs/midi';
const { Midi } = pkg;

import { fileURLToPath } from 'url';
import { createServer } from 'net';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const extensionInfo = {
  name: "G-Midi",
  description: "Now everyone can be a Mozart.",
  version: "1.0",
  author: "-Yıldırım"
};

const ext = new Extension(extensionInfo);
ext.run();

const SETTINGS_FILE = path.join(__dirname, 'public/settings.json');
let mainWindow = null;

function getSettings() {
  if (existsSync(SETTINGS_FILE)) {
    const data = readFileSync(SETTINGS_FILE, 'utf8');
    return JSON.parse(data);
  }
  return { alwaysOnTop: false };
}

function saveSettings(settings) {
  try {
    writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
  } catch (error) {
    console.error("Failed to save settings:", error);
  }
}

function sendPrivateMessage(text) {
  const chatPacket = new HPacket(`{in:Chat}{i:-1}{s:"${text}"}{i:0}{i:33}{i:0}{i:0}`);
  ext.sendToClient(chatPacket);
}

function midiToNoteName(midi) {
  const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const octave = Math.floor(midi / 12) - 1;
  return noteNames[midi % 12] + octave;
}

let currentMidiData = null;
let isPlaying = false;
let startTime = 0;
let scheduledTimeouts = [];

let isMappingKeys = false;
let mappingKeys = [];

const pianoNotesOrder = [
  "D3", "D#3", "E3", "F3", "F#3", "G3", "G#3", "A3", "A#3", "B3",
  "C4", "C#4", "D4", "D#4", "E4", "F4", "F#4", "G4", "G#4", "A4", "A#4", "B4",
  "C5", "C#5", "D5", "D#5", "E5", "F5", "F#5", "G5", "G#5", "A5", "A#5", "B5",
  "C6", "C#6", "D6"
];

const defaultMapping = {
  "D3":   2147420196,
  "D#3":  2147420352,
  "E3":   2147420199,
  "F3":   2147420202,
  "F#3":  2147420354,
  "G3":   2147420205,
  "G#3":  2147420358,
  "A3":   2147420208,
  "A#3":  2147420359,
  "B3":   2147420214,
  "C4":   2147420211,
  "C#4":  2147420360,
  "D4":   2147420215,
  "D#4":  2147420362,
  "E4":   2147420220,
  "F4":   2147420230,
  "F#4":  2147420364,
  "G4":   2147420223,
  "G#4":  2147420366,
  "A4":   2147420233,
  "A#4":  2147420368,
  "B4":   2147420226,
  "C5":   2147420236,
  "C#5":  2147420370,
  "D5":   2147420228,
  "D#5":  2147420372,
  "E5":   2147420239,
  "F5":   2147420244,
  "F#5":  2147420374,
  "G5":   2147420269,
  "G#5":  2147420376,
  "A5":   2147420247,
  "A#5":  2147420378,
  "B5":   2147420268,
  "C6":   2147420250,
  "C#6":  2147420380,
  "D6":   2147420265
};

let activeMapping = { ...defaultMapping };
let activeConfigName = null; 

const configDir = path.join(__dirname, 'configs');
if (!existsSync(configDir)) {
  mkdirSync(configDir);
}

function ensureDefaultConfig() {
  const defaultConfigPath = path.join(configDir, 'default.json');
  if (!existsSync(defaultConfigPath)) {
    writeFileSync(defaultConfigPath, JSON.stringify(defaultMapping, null, 2));
    console.log("Default config created");
  }
  activeMapping = JSON.parse(readFileSync(defaultConfigPath, 'utf8'));
  activeConfigName = 'default';
}

ensureDefaultConfig();

ext.interceptByNameOrHash(HDirection.TOSERVER, 'ClickFurni', hMessage => {
  if (isMappingKeys) {
    let packet = hMessage.getPacket();
    const furniId = packet.readInteger();
    mappingKeys.push(furniId);
    sendPrivateMessage(`Key recorded: ${mappingKeys.length}/37`);
    if (mappingKeys.length === pianoNotesOrder.length) {
      isMappingKeys = false;
      sendPrivateMessage("All keys recorded. Please give your config file a name with the :save configName command.");
    }
  }
});

ext.interceptByNameOrHash(HDirection.TOSERVER, 'Chat', hMessage => {
  const packet = hMessage.getPacket();
  const text = packet.readString();
  
  if (text === ':abort') {
    hMessage.blocked = true;
    abortKeyMapping();
    return;
  }
  
  if (text.startsWith(':save ')) {
    hMessage.blocked = true; 
    const configName = text.slice(8).trim();
    if (mappingKeys.length !== pianoNotesOrder.length) {
      sendPrivateMessage("Key mapping incomplete. Please record all keys.");
      return;
    }
    const configMapping = {};
    for (let i = 0; i < pianoNotesOrder.length; i++) {
      configMapping[pianoNotesOrder[i]] = mappingKeys[i];
    }
    const filePath = path.join(configDir, `${configName}.json`);
    writeFileSync(filePath, JSON.stringify(configMapping, null, 2));
    activeMapping = configMapping;
    activeConfigName = configName;
    sendPrivateMessage(`Config ${configName}.json saved and activated.`);
    mappingKeys = [];
  }
});

ext.on('click', async () => {
  const url = `http://localhost:${PORT}`;
  const settings = getSettings(); 

  try {
    if (!mainWindow) {
      mainWindow = new BrowserWindow({
        width: 800,
        height: 600,
        webPreferences: {
          nodeIntegration: true,
          contextIsolation: false
        },
        alwaysOnTop: settings.alwaysOnTop,
        autoHideMenuBar: true, 
        icon: path.join(__dirname, 'public', 'favicon.ico') 
      });

      mainWindow.loadURL(url);
      mainWindow.on('closed', () => {
        mainWindow = null;
      });

    } else {
      mainWindow.focus();
    }
  } catch (error) {
    console.error("Error:", error);
  }
});

function clickPianoFurni(furniId) {
  let packet = new HPacket(`{out:ClickFurni}{i:${furniId}}{i:0}`);
  ext.sendToServer(packet);
}

function playMidi() {
  if (!currentMidiData) return;
  stopMidi();
  isPlaying = true;
  startTime = Date.now();
  const track = currentMidiData.tracks[0];
  track.notes.forEach(note => {
    if (track.channel === 9) return;
    let midiNumber = note.midi;
    while (midiNumber < 50) midiNumber += 12;
    while (midiNumber > 86) midiNumber -= 12;
    const adjustedNoteName = midiToNoteName(midiNumber);
    if (!activeMapping[adjustedNoteName]) return;
    const startMs = note.time * 1000;
    const timeoutId = setTimeout(() => {
      if (!isPlaying) return;
      const furniId = activeMapping[adjustedNoteName];
      clickPianoFurni(furniId);
    }, startMs);
    scheduledTimeouts.push(timeoutId);
  });
}

function stopMidi() {
  isPlaying = false;
  scheduledTimeouts.forEach(tid => clearTimeout(tid));
  scheduledTimeouts = [];
}

function pauseMidi() {
  stopMidi();
}

const appServer = express();
appServer.use(express.static('public'));
appServer.use(fileUpload());
appServer.use(express.json());

appServer.post('/upload', (req, res) => {
  if (!req.files || !req.files.midiFile) {
    return res.status(400).send("MIDI file not uploaded!");
  }
  const midiFile = req.files.midiFile;
  try {
    const midiBuffer = midiFile.data;
    currentMidiData = new Midi(midiBuffer);
    console.log(">> MIDI file uploaded, track count:", currentMidiData.tracks.length);
    return res.sendStatus(200);
  } catch (e) {
    console.error(e);
    return res.status(500).send("parse error!");
  }
});

appServer.get('/play', (req, res) => {
  playMidi();
  res.send("Playback started!");
});
appServer.get('/pause', (req, res) => {
  pauseMidi();
  res.send("Paused!");
});
appServer.get('/stop', (req, res) => {
  stopMidi();
  res.send("Stopped!");
});

appServer.post('/startMapping', (req, res) => {
  isMappingKeys = true;
  mappingKeys = [];
  res.send("Key mapping mode started. Please press the piano keys in order (left to right).");
});

appServer.get('/configs', (req, res) => {
  let files = readdirSync(configDir).filter(f => f.endsWith('.json'));
  files = files.map(f => f.replace('.json', ''));
  res.json(files);
});

appServer.get('/config', (req, res) => {
  const configName = req.query.name;
  if (!configName) return res.status(400).send("Config name required.");
  const filePath = path.join(configDir, `${configName}.json`);
  if (!existsSync(filePath)) return res.status(404).send("Config not found.");
  const content = readFileSync(filePath, 'utf8');
  res.json({ name: configName, content: JSON.parse(content) });
});

appServer.post('/config', (req, res) => {
  const { name, newName, content } = req.body;
  if (!name || !content) return res.status(400).send("Config name and content required.");
  const filePath = path.join(configDir, `${name}.json`);
  if (!existsSync(filePath)) return res.status(404).send("Config not found.");
  let finalName = name;
  if (newName && newName !== name) {
    const newFilePath = path.join(configDir, `${newName}.json`);
    require('fs').renameSync(filePath, newFilePath);
    finalName = newName;
  }
  writeFileSync(path.join(configDir, `${finalName}.json`), JSON.stringify(content, null, 2));
  res.send(`Config ${finalName}.json updated.`);
});

appServer.delete('/config', (req, res) => {
  const configName = req.query.name;
  if (!configName) return res.status(400).send("Config name required.");
  const filePath = path.join(configDir, `${configName}.json`);
  if (!existsSync(filePath)) return res.status(404).send("Config not found.");
  unlinkSync(filePath);
  res.send(`Config ${configName}.json deleted.`);
});

appServer.post('/setActiveConfig', (req, res) => {
  const { configName } = req.body;
  if (!configName) return res.status(400).send("Config name required.");
  const filePath = path.join(configDir, `${configName}.json`);
  if (!existsSync(filePath)) return res.status(404).send("Config not found.");
  const configMapping = JSON.parse(readFileSync(filePath, 'utf8'));
  activeMapping = configMapping;
  activeConfigName = configName;
  res.send(`Active config set to ${configName}.json`);
});

appServer.get('/activeConfig', (req, res) => {
  res.json({ activeConfigName });
});

appServer.post('/save-settings', (req, res) => {
  const settings = req.body;
  saveSettings(settings);

  if (mainWindow && settings.alwaysOnTop !== getSettings().alwaysOnTop) {
    mainWindow.setAlwaysOnTop(settings.alwaysOnTop);
  }

  res.send("Settings saved.");
});

function getAvailablePort(start = 5000, end = 9999) {
  return new Promise((resolve, reject) => {
    const tryPort = (port) => {
      if (port > end) return reject(new Error('No free port found'));
      const server = createServer();
      server.once('error', () => tryPort(port + 1));
      server.once('listening', () => {
        server.close(() => resolve(port));
      });
      server.listen(port);
    };
    tryPort(start);
  });
}

const PORT = await getAvailablePort();
appServer.listen(PORT, () => {
 
});

app.on('ready', () => {

});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    app.emit('ready');
  }
});

ext.on('click', () => {
  const settings = getSettings(); 

  if (mainWindow) {
    mainWindow.focus();
  } else {
    mainWindow = new BrowserWindow({
      width: 800,
      height: 600,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      },
      alwaysOnTop: settings.alwaysOnTop,
      autoHideMenuBar: true, 
      icon: path.join(__dirname, 'public', 'favicon.ico')
    });

    mainWindow.loadURL(`http://localhost:${PORT}`);
    mainWindow.on('closed', () => {
      mainWindow = null;
    });
  }
});

ext.on('disconnect', () => {
  if (mainWindow) {
    mainWindow.close();
  }
  
  app.quit();
});

appServer.get('/duration', (req, res) => {
  if (!currentMidiData) {
    return res.status(400).json({ error: "No MIDI file loaded" });
  }
  const duration = currentMidiData.duration;
  res.json({ duration });
});

appServer.get('/seek', (req, res) => {
  if (!currentMidiData) {
    return res.status(400).send("No MIDI file loaded");
  }
  
  const seekTime = parseFloat(req.query.time);
  if (isNaN(seekTime)) {
    return res.status(400).send("Invalid time parameter");
  }

  stopMidi();
  isPlaying = true;
  startTime = Date.now() - (seekTime * 1000);
  
  const track = currentMidiData.tracks[0];
  track.notes.forEach(note => {
    if (track.channel === 9) return;
    let midiNumber = note.midi;
    while (midiNumber < 50) midiNumber += 12;
    while (midiNumber > 86) midiNumber -= 12;
    
    const adjustedNoteName = midiToNoteName(midiNumber);
    if (!activeMapping[adjustedNoteName]) return;
    
    const noteStartTime = note.time * 1000;
    if (noteStartTime < seekTime * 1000) return;
    
    const timeoutDelay = noteStartTime - (seekTime * 1000);
    const timeoutId = setTimeout(() => {
      if (!isPlaying) return;
      const furniId = activeMapping[adjustedNoteName];
      clickPianoFurni(furniId);
    }, timeoutDelay);
    scheduledTimeouts.push(timeoutId);
  });
  
  res.sendStatus(200);
});

function abortKeyMapping() {
  if (isMappingKeys) {
    isMappingKeys = false;
    mappingKeys = [];
    sendPrivateMessage("Key mapping cancelled.");
  }
}

appServer.post('/abortMapping', (req, res) => {
  abortKeyMapping();
  res.send("Key mapping cancelled.");
});