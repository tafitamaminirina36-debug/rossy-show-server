import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { fileURLToPath } from 'url';
import xlsx from 'xlsx';
import dotenv from 'dotenv';
import pool, { withTransaction } from './db.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'rossy-show-2026-secret-key';

const PREVENTE_MAX = 2000;
const TOTAL_TICKETS = 12000;

// ─── Middleware ───
app.use(cors());
app.use(express.json());

// ─── Auth Middleware ───
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token manquant' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Token invalide' });
    req.user = user;
    next();
  });
};

// ─── Normalisation référence ───
function normalizeReference(ref) {
  if (!ref) return '';
  let r = ref.toString().toUpperCase().trim();

  const match = r.match(/RMAI\s*(\d{1,5})/);
  if (!match) {
    const numMatch = r.match(/^(\d{1,5})$/);
    if (!numMatch) return '';
    const num = numMatch[1].replace(/O/g, '0').padStart(5, '0');
    const numInt = parseInt(num, 10);
    if (numInt < 1 || numInt > TOTAL_TICKETS) return '';
    return 'RMAI ' + num;
  }

  let num = match[1].replace(/O/g, '0').padStart(5, '0');
  const numInt = parseInt(num, 10);
  if (numInt < 1 || numInt > TOTAL_TICKETS) return '';
  return 'RMAI ' + num;
}

// ─── Initialisation Base de données ───
async function initDatabase() {
  try {
    await pool.query(`CREATE DATABASE IF NOT EXISTS ${process.env.DB_NAME || 'rossy_show'} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await pool.query(`USE ${process.env.DB_NAME || 'rossy_show'}`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS tickets (
        id VARCHAR(36) PRIMARY KEY,
        reference VARCHAR(20) UNIQUE NOT NULL,
        type VARCHAR(20) NOT NULL,
        price INT NOT NULL,
        status VARCHAR(20) DEFAULT 'available',
        scannedAt DATETIME DEFAULT NULL,
        scannedBy VARCHAR(100) DEFAULT NULL,
        scanCount INT DEFAULT 0,
        deviceId VARCHAR(100) DEFAULT NULL,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_reference (reference),
        INDEX idx_status (status),
        INDEX idx_scannedAt (scannedAt)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS scans (
        id VARCHAR(36) PRIMARY KEY,
        reference VARCHAR(20) NOT NULL,
        ticketId VARCHAR(36) DEFAULT NULL,
        status VARCHAR(20) NOT NULL,
        message TEXT,
        firstScanAt DATETIME DEFAULT NULL,
        scannedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        scannedBy VARCHAR(100) DEFAULT NULL,
        deviceId VARCHAR(100) DEFAULT NULL,
        isPrevente TINYINT(1) DEFAULT 0,
        INDEX idx_reference (reference),
        INDEX idx_scannedAt (scannedAt),
        INDEX idx_status (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS scanners (
        id VARCHAR(36) PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        username VARCHAR(100) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        scanCount INT DEFAULT 0,
        INDEX idx_username (username)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    console.log('✅ Base MySQL initialisée');
  } catch (err) {
    console.error('❌ Erreur init DB:', err.message);
    throw err;
  }
}

async function initData() {
  await initDatabase();

  const [rows] = await pool.query('SELECT COUNT(*) as count FROM tickets');
  const count = rows[0].count;

  if (count === 0) {
    console.log('📦 Génération des 12000 billets...');

    const values = [];
    for (let i = 1; i <= 12000; i++) {
      const num = String(i).padStart(5, '0');
      const isPrevente = i <= 2000;
      values.push([
        uuidv4(),
        'RMAI ' + num,
        isPrevente ? 'prevention' : 'standard',
        isPrevente ? 5000 : 7000,
        'available',
        0,
        new Date().toISOString()
      ]);
    }

    const batchSize = 1000;
    for (let i = 0; i < values.length; i += batchSize) {
      const batch = values.slice(i, i + batchSize);
      const placeholders = batch.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(',');
      const flatValues = batch.flat();
      await pool.query(
        `INSERT INTO tickets (id, reference, type, price, status, scanCount, createdAt) VALUES ${placeholders}`,
        flatValues
      );
      console.log(`  → ${Math.min(i + batchSize, 12000)}/12000 billets insérés`);
    }
    console.log('✅ 12000 billets créés');
  } else {
    console.log('✅', count, 'billets déjà en base');
  }

  const [scannerRows] = await pool.query('SELECT COUNT(*) as count FROM scanners');
  if (scannerRows[0].count === 0) {
    for (let i = 1; i <= 10; i++) {
      const hashedPassword = await bcrypt.hash('scanner' + i + '2026', 10);
      await pool.query(
        'INSERT INTO scanners (id, name, username, password, createdAt) VALUES (?, ?, ?, ?, ?)',
        [uuidv4(), 'Scanner ' + i, 'scanner' + i, hashedPassword, new Date().toISOString()]
      );
    }
    console.log('✅ 10 scanners créés');
  }
}

// ─── ROUTES ───

// Login
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  const hashedAdmin = await bcrypt.hash('admin123', 10);
  if (username === 'admin' && await bcrypt.compare(password, hashedAdmin)) {
    const token = jwt.sign({ username, role: 'admin' }, JWT_SECRET, { expiresIn: '24h' });
    return res.json({ token, user: { username, role: 'admin', name: 'Administrateur' } });
  }

  const [scanners] = await pool.query('SELECT * FROM scanners WHERE username = ?', [username]);
  const scanner = scanners[0];

  if (scanner && await bcrypt.compare(password, scanner.password)) {
    const token = jwt.sign({ username, role: 'scanner', id: scanner.id }, JWT_SECRET, { expiresIn: '24h' });
    return res.json({ token, user: { username, role: 'scanner', id: scanner.id, name: scanner.name } });
  }

  res.status(401).json({ error: 'Identifiants invalides' });
});

// Test normalize (sans auth)
app.get('/api/test/normalize/:ref', (req, res) => {
  const ref = req.params.ref;
  const result = normalizeReference(ref);
  res.json({ input: ref, normalized: result, isValid: result !== '' });
});

// Test scan (sans auth)
app.post('/api/test/scan', async (req, res) => {
  const { reference } = req.body;
  const normalized = normalizeReference(reference);

  if (!normalized) {
    return res.json({ error: 'Format invalide', normalized });
  }

  const [tickets] = await pool.query('SELECT * FROM tickets WHERE reference = ?', [normalized]);
  const ticket = tickets[0];

  res.json({
    input: reference,
    normalized,
    found: !!ticket,
    ticket: ticket || null
  });
});

// Debug DB info
app.get('/api/debug/db-info', async (req, res) => {
  const [countRows] = await pool.query('SELECT COUNT(*) as count FROM tickets');
  const [sampleRows] = await pool.query('SELECT reference FROM tickets LIMIT 5');

  res.json({
    ticketCount: countRows[0].count,
    sampleReferences: sampleRows.map(t => t.reference)
  });
});

// Scan ticket
app.post('/api/scan', authenticateToken, async (req, res) => {
  const { reference, deviceId = 'default' } = req.body;

  if (!reference || !reference.trim()) {
    return res.status(400).json({ error: 'Référence vide' });
  }

  const normalizedRef = normalizeReference(reference);

  if (!normalizedRef) {
    const scanId = uuidv4();
    await pool.query(
      'INSERT INTO scans (id, reference, status, message, scannedAt, scannedBy, deviceId) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [scanId, reference.trim().toUpperCase(), 'not_found', 'Format invalide (RMAI 00001 à RMAI 12000)', new Date().toISOString(), req.user.username, deviceId]
    );

    return res.status(404).json({
      error: 'Format invalide',
      scan: { id: scanId, reference: reference.trim().toUpperCase(), status: 'not_found', message: 'Format invalide (RMAI 00001 à RMAI 12000)' }
    });
  }

  const [tickets] = await pool.query('SELECT * FROM tickets WHERE reference = ?', [normalizedRef]);
  const ticket = tickets[0];

  if (!ticket) {
    const scanId = uuidv4();
    await pool.query(
      'INSERT INTO scans (id, reference, status, message, scannedAt, scannedBy, deviceId) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [scanId, normalizedRef, 'not_found', 'Billet non trouvé', new Date().toISOString(), req.user.username, deviceId]
    );

    return res.status(404).json({
      error: 'Billet non trouvé',
      scan: { id: scanId, reference: normalizedRef, status: 'not_found', message: 'Billet non trouvé' }
    });
  }

  if (ticket.scannedAt) {
    const scanId = uuidv4();
    await pool.query(
      'INSERT INTO scans (id, reference, ticketId, status, message, firstScanAt, scannedAt, scannedBy, deviceId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [scanId, normalizedRef, ticket.id, 'duplicate', 'Billet déjà scanné!', ticket.scannedAt, new Date().toISOString(), req.user.username, deviceId]
    );

    return res.status(409).json({
      error: 'Billet déjà scanné',
      ticket,
      scan: { id: scanId, reference: normalizedRef, status: 'duplicate', message: 'Billet déjà scanné!', firstScanAt: ticket.scannedAt },
      isDuplicate: true
    });
  }

  const now = new Date().toISOString();
  const num = parseInt(ticket.reference.replace(/[^0-9]/g, ''), 10);
  const isPrevente = num <= PREVENTE_MAX;
  const scanStatus = isPrevente ? 'prevente' : 'success';
  const scanMessage = isPrevente ? 'ENTRÉE PRÉVENTE OK' : 'ENTRÉE OK';

  await pool.query(
    'UPDATE tickets SET status = ?, scannedAt = ?, scannedBy = ?, deviceId = ?, scanCount = scanCount + 1 WHERE reference = ?',
    ['scanned', now, req.user.username, deviceId, normalizedRef]
  );

  const scanId = uuidv4();
  await pool.query(
    'INSERT INTO scans (id, reference, ticketId, status, message, scannedAt, scannedBy, deviceId, isPrevente) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [scanId, normalizedRef, ticket.id, scanStatus, scanMessage, now, req.user.username, deviceId, isPrevente ? 1 : 0]
  );

  res.json({
    success: true,
    ticket: { ...ticket, status: 'scanned', scannedAt: now, scannedBy: req.user.username },
    scan: { id: scanId, reference: normalizedRef, status: scanStatus, message: scanMessage, scannedAt: now },
    isPrevente
  });
});

// Recherche tickets
app.get('/api/tickets/search', authenticateToken, async (req, res) => {
  const { q } = req.query;
  if (!q || !q.trim()) return res.json([]);

  const normalized = normalizeReference(q);
  if (!normalized) {
    const [results] = await pool.query(
      "SELECT * FROM tickets WHERE reference LIKE ? LIMIT 20",
      ['%' + q.toUpperCase().trim() + '%']
    );
    return res.json(results);
  }

  const numPart = normalized.replace(/[^0-9]/g, '');
  const [results] = await pool.query(
    'SELECT * FROM tickets WHERE reference LIKE ? OR reference = ? LIMIT 20',
    ['%' + numPart + '%', normalized]
  );

  res.json(results);
});

// Liste scans
app.get('/api/scans', authenticateToken, async (req, res) => {
  const [scans] = await pool.query('SELECT * FROM scans ORDER BY scannedAt DESC');
  res.json(scans);
});

// Statistiques
app.get('/api/stats', authenticateToken, async (req, res) => {
  const [[total]] = await pool.query('SELECT COUNT(*) as count FROM tickets');
  const [[scanned]] = await pool.query('SELECT COUNT(*) as count FROM tickets WHERE scannedAt IS NOT NULL');
  const [[prevente]] = await pool.query('SELECT COUNT(*) as count FROM tickets WHERE type = ? AND scannedAt IS NOT NULL', ['prevention']);
  const [[normal]] = await pool.query('SELECT COUNT(*) as count FROM tickets WHERE type = ? AND scannedAt IS NOT NULL', ['standard']);
  const [[available]] = await pool.query('SELECT COUNT(*) as count FROM tickets WHERE scannedAt IS NULL');
  const [[duplicates]] = await pool.query('SELECT COUNT(*) as count FROM scans WHERE status = ?', ['duplicate']);
  const [[notFound]] = await pool.query('SELECT COUNT(*) as count FROM scans WHERE status = ?', ['not_found']);
  const [[totalScans]] = await pool.query('SELECT COUNT(*) as count FROM scans');

  res.json({
    total: total.count,
    scanned: scanned.count,
    prevente: prevente.count,
    normal: normal.count,
    available: available.count,
    duplicates: duplicates.count,
    notFound: notFound.count,
    totalScans: totalScans.count,
    successRate: total.count > 0 ? ((scanned.count / total.count) * 100).toFixed(1) : 0
  });
});

// ─── ROUTES SCANNERS CRUD ───

// GET /api/scanners - Liste tous les scanners
app.get('/api/scanners', authenticateToken, async (req, res) => {
  try {
    const [scanners] = await pool.query('SELECT id, name, username, scanCount, createdAt FROM scanners ORDER BY createdAt DESC');
    res.json(scanners);
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/scanners - Créer un scanner
app.post('/api/scanners', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Accès refusé - Admin uniquement' });
  }

  const { name, username, password } = req.body;

  if (!name || !username || !password) {
    return res.status(400).json({ error: 'Tous les champs sont requis' });
  }

  try {
    // Vérifier si max 10
    const [countRows] = await pool.query('SELECT COUNT(*) as count FROM scanners');
    if (countRows[0].count >= 10) {
      return res.status(400).json({ error: 'Maximum 10 scanners atteint' });
    }

    // Vérifier si username existe déjà
    const [existing] = await pool.query('SELECT id FROM scanners WHERE username = ?', [username]);
    if (existing.length > 0) {
      return res.status(400).json({ error: 'Username déjà utilisé' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const id = uuidv4();

    await pool.query(
      'INSERT INTO scanners (id, name, username, password, createdAt) VALUES (?, ?, ?, ?, ?)',
      [id, name, username, hashedPassword, new Date().toISOString()]
    );

    res.json({ success: true, id, message: 'Scanner créé' });
  } catch (err) {
    console.error('Erreur création scanner:', err);
    res.status(500).json({ error: 'Erreur création scanner' });
  }
});

// DELETE /api/scanners/:id - Supprimer un scanner
app.delete('/api/scanners/:id', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Accès refusé - Admin uniquement' });
  }

  const { id } = req.params;

  try {
    await pool.query('DELETE FROM scanners WHERE id = ?', [id]);
    res.json({ success: true, message: 'Scanner supprimé' });
  } catch (err) {
    res.status(500).json({ error: 'Erreur suppression' });
  }
});

// ─── EXPORT EXCEL ───

app.get('/api/export', authenticateToken, async (req, res) => {
  const { type = 'all' } = req.query;
  let dataToExport = [], filename = '';

  if (type === 'tickets') {
    const [tickets] = await pool.query('SELECT * FROM tickets');
    dataToExport = tickets.map(t => {
      const num = parseInt(t.reference.replace(/[^0-9]/g, ''), 10);
      return {
        'Référence': t.reference,
        'Type': num <= PREVENTE_MAX ? 'PRÉVENTE' : 'STANDARD',
        'Prix': t.price,
        'Statut': t.scannedAt ? 'SCANNÉ' : 'DISPONIBLE',
        'Date Scan': t.scannedAt || '-',
        'Scanné par': t.scannedBy || '-',
        'Compteur scan': t.scanCount || 0
      };
    });
    filename = 'billets_rossy_show.xlsx';
  } else if (type === 'scans') {
    const [scans] = await pool.query('SELECT * FROM scans ORDER BY scannedAt DESC');
    dataToExport = scans.map(s => ({
      'Référence': s.reference,
      'Statut': s.status === 'success' ? 'OK' : s.status === 'prevente' ? 'PRÉVENTE' : s.status === 'duplicate' ? 'DOUBLON' : 'NON TROUVÉ',
      'Message': s.message,
      'Date': s.scannedAt,
      'Opérateur': s.scannedBy,
      'Appareil': s.deviceId
    }));
    filename = 'scans_rossy_show.xlsx';
  } else {
    const [tickets] = await pool.query('SELECT * FROM tickets');
    dataToExport = tickets.map(t => {
      const num = parseInt(t.reference.replace(/[^0-9]/g, ''), 10);
      return {
        'Référence': t.reference,
        'Type': num <= PREVENTE_MAX ? 'PRÉVENTE' : 'STANDARD',
        'Prix': t.price,
        'Statut': t.scannedAt ? 'SCANNÉ' : 'DISPONIBLE',
        'Date Scan': t.scannedAt || '-',
        'Scanné par': t.scannedBy || '-'
      };
    });
    filename = 'complet_rossy_show.xlsx';
  }

  const ws = xlsx.utils.json_to_sheet(dataToExport);
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, 'Données');
  const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename=' + filename);
  res.send(buffer);
});

// Reset
app.post('/api/reset', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Accès refusé' });
  try {
    await pool.query("UPDATE tickets SET status = 'available', scannedAt = NULL, scannedBy = NULL, deviceId = NULL, scanCount = 0");
    await pool.query("DELETE FROM scans");
    await pool.query("UPDATE scanners SET scanCount = 0");
    res.json({ success: true, message: 'Réinitialisation OK' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erreur réinitialisation' });
  }
});

// Health check pour Render
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Démarrage
initData().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log('🚀 Serveur démarré sur http://0.0.0.0:' + PORT);
    console.log('');
    console.log('🔧 ROUTES DE TEST (pas besoin de token):');
    console.log('   GET  http://localhost:' + PORT + '/api/test/normalize/RMAI%2000001');
    console.log('   POST http://localhost:' + PORT + '/api/test/scan  body: {"reference":"RMAI 00001"}');
    console.log('   GET  http://localhost:' + PORT + '/api/debug/db-info');
    console.log('   GET  http://localhost:' + PORT + '/health');
  });
}).catch(err => {
  console.error('❌ Erreur au démarrage:', err);
  process.exit(1);
});
