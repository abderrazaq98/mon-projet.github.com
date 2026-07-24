const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DB_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const DB_PATH = path.join(DB_DIR, 'points.db');
const db = new DatabaseSync(DB_PATH);

// Création de la table points si elle n'existe pas
db.exec(`
  CREATE TABLE IF NOT EXISTS points (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ig TEXT,
    adresse TEXT,
    x REAL,
    y REAL,
    lat REAL,
    lng REAL,
    commentaire TEXT,
    numero_batiment TEXT,
    secteur_nom TEXT,
    secteur_numero TEXT,
    date_creation TEXT DEFAULT CURRENT_TIMESTAMP,
    date_modification TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

// Index pour accélérer la recherche sur de gros volumes
db.exec(`CREATE INDEX IF NOT EXISTS idx_points_ig ON points(ig);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_points_adresse ON points(adresse);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_points_batiment ON points(numero_batiment);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_points_secteur ON points(secteur_numero);`);

// Table secteurs
db.exec(`
  CREATE TABLE IF NOT EXISTS sectors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    numero TEXT,
    nom TEXT,
    agence TEXT,
    color TEXT DEFAULT '#1e5f8a',
    geometry TEXT,
    date_creation TEXT DEFAULT CURRENT_TIMESTAMP,
    date_modification TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_sectors_numero ON sectors(numero);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_sectors_nom ON sectors(nom);`);

module.exports = db;