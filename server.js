const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'accounts.json');
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '20kb' }));
app.use(express.urlencoded({ extended: false, limit: '20kb' }));
if (IS_PRODUCTION) app.set('trust proxy', 1);

app.use(session({
  name: 'fcb.sid',
  secret: process.env.SESSION_SECRET || 'local-simulation-secret-change-before-deployment',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PRODUCTION,
    maxAge: 1000 * 60 * 60
  }
}));

app.use('/api/auth', rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false
}));

function readDatabase() {
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}
function writeDatabase(db) {
  const temp = DATA_FILE + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(temp, DATA_FILE);
}
function publicAccount(account) {
  return {
    id: account.id,
    username: account.username,
    name: account.name,
    accountNumber: account.accountNumber,
    accountType: account.accountType,
    balance: Number(account.balance).toFixed(2)
  };
}
function requireAuth(req, res, next) {
  if (!req.session.accountId) {
    return res.status(401).json({ success: false, message: 'Please sign in to continue.' });
  }
  next();
}
function getCurrentAccount(req, db) {
  return db.accounts.find(account => account.id === req.session.accountId);
}
function validAmount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 &&
    value <= 1000000 && Math.round(value * 100) === value * 100;
}

// On first run, set INITIAL_ACCOUNT_PASSWORD in your terminal to choose the local sign-in password.
function initializeAccounts() {
  const db = readDatabase();
  const initialPassword = process.env.INITIAL_ACCOUNT_PASSWORD;
  let changed = false;
  for (const account of db.accounts) {
    if (!account.passwordHash && initialPassword) {
      account.passwordHash = bcrypt.hashSync(initialPassword, 12);
      changed = true;
    }
  }
  if (changed) writeDatabase(db);
  if (db.accounts.some(account => !account.passwordHash)) {
    console.warn('First-time setup required: set INITIAL_ACCOUNT_PASSWORD in your terminal, then restart the server.');
  }
}
initializeAccounts();

app.get('/api/health', (req, res) => {
  res.json({ success: true, app: 'Federal Credit Banking', simulation: true });
});

app.post('/api/auth/login', async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Enter your username and password.' });
  }
  const db = readDatabase();
  const account = db.accounts.find(item => item.username.toLowerCase() === username);
  if (account && !account.passwordHash) {
    return res.status(503).json({ success: false, message: 'Initial setup is incomplete. Set INITIAL_ACCOUNT_PASSWORD in the server terminal and restart.' });
  }
  if (!account || !(await bcrypt.compare(password, account.passwordHash))) {
    return res.status(401).json({ success: false, message: 'Invalid username or password.' });
  }
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ success: false, message: 'Could not start your session.' });
    req.session.accountId = account.id;
    res.json({ success: true, account: publicAccount(account) });
  });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) return res.status(500).json({ success: false, message: 'Could not sign out.' });
    res.clearCookie('fcb.sid');
    res.json({ success: true });
  });
});

app.get('/api/me', requireAuth, (req, res) => {
  const db = readDatabase();
  const account = getCurrentAccount(req, db);
  if (!account) return res.status(401).json({ success: false, message: 'Session account not found.' });
  res.json({ success: true, account: publicAccount(account) });
});

app.get('/api/transactions', requireAuth, (req, res) => {
  const db = readDatabase();
  const account = getCurrentAccount(req, db);
  if (!account) return res.status(401).json({ success: false, message: 'Please sign in again.' });
  const transactions = db.transactions.filter(tx => tx.accountId === account.id).slice().reverse().slice(0, 50);
  res.json({ success: true, transactions });
});

app.post('/api/transactions/deposit', requireAuth, (req, res) => {
  const amount = Number(req.body.amount);
  if (!validAmount(amount)) {
    return res.status(400).json({ success: false, message: 'Enter an amount between $0.01 and $1,000,000.00, with up to two decimal places.' });
  }
  const db = readDatabase();
  const account = getCurrentAccount(req, db);
  if (!account) return res.status(401).json({ success: false, message: 'Please sign in again.' });
  account.balance = Math.round((account.balance + amount) * 100) / 100;
  db.transactions.push({
    id: 'TX' + Date.now() + Math.random().toString(36).slice(2, 7).toUpperCase(),
    accountId: account.id, type: 'Deposit', amount: amount.toFixed(2),
    description: 'Practice deposit — fictional funds', createdAt: new Date().toISOString()
  });
  writeDatabase(db);
  res.json({ success: true, account: publicAccount(account), message: 'Deposit recorded in the simulation.' });
});

app.post('/api/transactions/withdraw', requireAuth, (req, res) => {
  const amount = Number(req.body.amount);
  if (!validAmount(amount)) {
    return res.status(400).json({ success: false, message: 'Enter an amount between $0.01 and $1,000,000.00, with up to two decimal places.' });
  }
  const db = readDatabase();
  const account = getCurrentAccount(req, db);
  if (!account) return res.status(401).json({ success: false, message: 'Please sign in again.' });
  if (amount > account.balance) return res.status(400).json({ success: false, message: 'Insufficient available balance.' });
  account.balance = Math.round((account.balance - amount) * 100) / 100;
  db.transactions.push({
    id: 'TX' + Date.now() + Math.random().toString(36).slice(2, 7).toUpperCase(),
    accountId: account.id, type: 'Withdrawal', amount: (-amount).toFixed(2),
    description: 'Practice withdrawal — fictional funds', createdAt: new Date().toISOString()
  });
  writeDatabase(db);
  res.json({ success: true, account: publicAccount(account), message: 'Withdrawal recorded in the simulation.' });
});

app.post('/api/transactions/transfer', requireAuth, (req, res) => {
  const amount = Number(req.body.amount);
  const recipientNumber = String(req.body.accountNumber || '').replace(/\s/g, '');
  if (!validAmount(amount) || !/^\d{10}$/.test(recipientNumber)) {
    return res.status(400).json({ success: false, message: 'Enter a valid amount and 10-digit recipient account number.' });
  }
  const db = readDatabase();
  const sender = getCurrentAccount(req, db);
  const recipient = db.accounts.find(account => account.accountNumber === recipientNumber);
  if (!sender) return res.status(401).json({ success: false, message: 'Please sign in again.' });
  if (!recipient || recipient.id === sender.id) {
    return res.status(400).json({ success: false, message: 'Choose another valid account.' });
  }
  if (amount > sender.balance) return res.status(400).json({ success: false, message: 'Insufficient available balance.' });
  sender.balance = Math.round((sender.balance - amount) * 100) / 100;
  recipient.balance = Math.round((recipient.balance + amount) * 100) / 100;
  const createdAt = new Date().toISOString();
  const reference = 'TX' + Date.now() + Math.random().toString(36).slice(2, 7).toUpperCase();
  db.transactions.push(
    { id: reference, accountId: sender.id, type: 'Transfer sent', amount: (-amount).toFixed(2), description: 'Practice transfer to ' + recipient.name, createdAt },
    { id: reference + 'R', accountId: recipient.id, type: 'Transfer received', amount: amount.toFixed(2), description: 'Practice transfer from ' + sender.name, createdAt }
  );
  writeDatabase(db);
  res.json({ success: true, account: publicAccount(sender), message: 'Transfer recorded in the simulation.' });
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/{*splat}', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`Federal Credit Banking running at http://localhost:${PORT}`);
  console.log();
});
