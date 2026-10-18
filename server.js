const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// FIXED PATHS: Now points directly to your main folder instead of subfolders
const DATA_FILE = path.join(__dirname, 'accounts.json');
const PUBLIC_DIR = __dirname; 

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '20kb' }));
app.use(express.urlencoded({ extended: false, limit: '20kb' }));

if (IS_PRODUCTION) {
  app.set('trust proxy', 1);
}

app.use(session({
  name: 'acf.sid',
  secret: process.env.SESSION_SECRET || 'local-simulation-secret-change-before-deployment',
  resave: false,
  saveUninitialized: false,
  proxy: true, 
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

function ensureDataFile() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(
      DATA_FILE,
      JSON.stringify({ accounts: [], transactions: [] }, null, 2),
      'utf8'
    );
  }
}

function readDatabase() {
  ensureDataFile();
  const db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (!db || !Array.isArray(db.accounts) || !Array.isArray(db.transactions)) {
    throw new Error('accounts.json must contain accounts and transactions arrays.');
  }
  return db;
}

function writeDatabase(db) {
  ensureDataFile();
  const tempFile = DATA_FILE + '.tmp';
  fs.writeFileSync(tempFile, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tempFile, DATA_FILE);
}

function publicAccount(account) {
  return {
    id: account.id,
    username: account.username,
    name: account.name,
    accountNumber: account.accountNumber,
    accountType: account.accountType || 'Everyday Checking',
    checkingBalance: Number(account.checkingBalance ?? account.balance ?? 0).toFixed(2),
    savingsBalance: Number(account.savingsBalance ?? 0).toFixed(2),
    savingsAccountNumber: account.savingsAccountNumber || account.accountNumber
  };
}

function getCurrentAccount(req, db) {
  return db.accounts.find(account => account.id === req.session.accountId);
}

function requireAuth(req, res, next) {
  if (!req.session.accountId) {
    return res.status(401).json({ success: false, message: 'Please sign in to continue.' });
  }
  next();
}

function validAmount(value) {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= 1000000 &&
    Math.round(value * 100) === value * 100
  );
}

function initializeAccounts() {
  const db = readDatabase();
  let changed = false;
  const initialPassword = process.env.INITIAL_ACCOUNT_PASSWORD;

  for (const account of db.accounts) {
    if (account.checkingBalance === undefined) {
      account.checkingBalance = Number(account.balance || 0);
      delete account.balance;
      changed = true;
    }
    if (account.savingsBalance === undefined) {
      account.savingsBalance = 0;
      changed = true;
    }
    if (!account.passwordHash && initialPassword) {
      account.passwordHash = bcrypt.hashSync(initialPassword, 12);
      changed = true;
    }
  }

  if (changed) {
    writeDatabase(db);
  }
}
initializeAccounts();

// Serve files directly from the main folder
app.use(express.static(PUBLIC_DIR));

app.get('/api/health', (req, res) => {
  res.json({ success: true, app: 'Apex Crest Financial Asset API', simulation: true });
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const username = String(req.body.username || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (!username || !password) {
      return res.status(400).json({ success: false, message: 'Enter your username and password.' });
    }

    const db = readDatabase();
    const account = db.accounts.find(item => String(item.username || '').toLowerCase() === username);

    if (!account || !(await bcrypt.compare(password, account.passwordHash))) {
      return res.status(401).json({ success: false, message: 'Invalid username or password.' });
    }

    req.session.regenerate(err => {
      if (err) return res.status(500).json({ success: false, message: 'Could not start your session.' });
      req.session.accountId = account.id;
      req.session.save(saveError => {
        if (saveError) return res.status(500).json({ success: false, message: 'Could not save your session.' });
        return res.json({ success: true, account: publicAccount(account) });
      });
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Unable to sign in right now.' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) return res.status(500).json({ success: false, message: 'Could not sign out.' });
    res.clearCookie('acf.sid');
    res.json({ success: true });
  });
});

app.get('/api/me', requireAuth, (req, res) => {
  const db = readDatabase();
  const account = getCurrentAccount(req, db);
  if (!account) return res.status(401).json({ success: false, message: 'Session expired.' });
  res.json({ success: true, account: publicAccount(account) });
});

app.get('/api/transactions', requireAuth, (req, res) => {
  try {
    const db = readDatabase();
    const account = getCurrentAccount(req, db);

    if (!account) return res.status(401).json({ success: false, message: 'Client session missing.' });

    const userTransactions = db.transactions.filter(tx => tx.accountId === account.id);
    userTransactions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.json({ success: true, transactions: userTransactions });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Unable to retrieve records.' });
  }
});

app.post('/api/deposit', requireAuth, (req, res) => {
  try {
    const amount = Number(req.body.amount);
    const targetType = String(req.body.accountType).toLowerCase();

    if (!validAmount(amount)) return res.status(400).json({ success: false, message: 'Invalid deposit amount.' });
    if (targetType !== 'checking' && targetType !== 'savings') return res.status(400).json({ success: false, message: 'Invalid target selection.' });

    const db = readDatabase();
    const account = db.accounts.find(acc => acc.id === req.session.accountId);

    if (targetType === 'checking') {
      account.checkingBalance = Number((account.checkingBalance + amount).toFixed(2));
    } else {
      account.savingsBalance = Number((account.savingsBalance + amount).toFixed(2));
    }

    db.transactions.push({
      id: 'TX' + Date.now() + Math.random().toString(36).substr(2, 5).toUpperCase(),
      accountId: account.id,
      accountType: targetType,
      type: 'Deposit',
      amount: amount,
      description: `Deposit — ${targetType.charAt(0).toUpperCase() + targetType.slice(1)}`,
      createdAt: new Date().toISOString()
    });

    writeDatabase(db);
    res.json({ success: true, message: 'Deposit completed successfully.', account: publicAccount(account) });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Processing system error.' });
  }
});

app.post('/api/withdraw', requireAuth, (req, res) => {
  try {
    const amount = Number(req.body.amount);
    const sourceType = String(req.body.accountType).toLowerCase();

    if (!validAmount(amount)) return res.status(400).json({ success: false, message: 'Invalid withdrawal amount.' });
    
    const db = readDatabase();
    const account = db.accounts.find(acc => acc.id === req.session.accountId);

    const balance = sourceType === 'checking' ? account.checkingBalance : account.savingsBalance;
    if (balance < amount) return res.status(400).json({ success: false, message: 'Insufficient funds available.' });

    if (sourceType === 'checking') {
      account.checkingBalance = Number((account.checkingBalance - amount).toFixed(2));
    } else {
      account.savingsBalance = Number((account.savingsBalance - amount).toFixed(2));
    }

    db.transactions.push({
      id: 'TX' + Date.now() + Math.random().toString(36).substr(2, 5).toUpperCase(),
      accountId: account.id,
      accountType: sourceType,
      type: 'Withdrawal',
      amount: -amount,
      description: `Withdrawal — ${sourceType.charAt(0).toUpperCase() + sourceType.slice(1)}`,
      createdAt: new Date().toISOString()
    });

    writeDatabase(db);
    res.json({ success: true, message: 'Withdrawal completed.', account: publicAccount(account) });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Processing system error.' });
  }
});

app.post('/api/transfer', requireAuth, (req, res) => {
  try {
    const amount = Number(req.body.amount);
    const sourceType = String(req.body.accountType).toLowerCase();
    const recipientNum = String(req.body.recipientAccount || '').trim();

    if (!validAmount(amount)) return res.status(400).json({ success: false, message: 'Invalid transfer amount.' });

    const db = readDatabase();
    const sender = db.accounts.find(acc => acc.id === req.session.accountId);
    const recipient = db.accounts.find(acc => acc.accountNumber === recipientNum);

    if (!recipient) return res.status(404).json({ success: false, message: 'Recipient routing info not found.' });
    if (sender.accountNumber === recipientNum) return res.status(400).json({ success: false, message: 'Cannot transfer to origin account.' });

    const balance = sourceType === 'checking' ? sender.checkingBalance : sender.savingsBalance;
    if (balance < amount) return res.status(400).json({ success: false, message: 'Insufficient funds available.' });

