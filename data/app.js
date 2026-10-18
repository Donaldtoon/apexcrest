const selectElement = selector => document.querySelector(selector);
const loginView = selectElement('#loginView');
const dashboardView = selectElement('#dashboardView');
let toastTimer;

function formatMoney(value) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(value || 0));
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || 'Error executing network request.');
  return body;
}

function showToast(message, isError = false) {
  const toast = selectElement('#toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.toggle('error', isError);
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3500);
}

function showLogin() { 
  if (dashboardView) dashboardView.classList.add('hidden'); 
  if (loginView) loginView.classList.remove('hidden'); 
}

function showDashboard() { 
  if (loginView) loginView.classList.add('hidden'); 
  if (dashboardView) dashboardView.classList.remove('hidden'); 
}

function renderAccount(account) {
  if (!account) return;
  if (selectElement('#memberName')) selectElement('#memberName').textContent = account.name || 'Client';
  if (selectElement('#checkingBalanceValue')) selectElement('#checkingBalanceValue').textContent = formatMoney(account.checkingBalance);
  if (selectElement('#savingsBalanceValue')) selectElement('#savingsBalanceValue').textContent = formatMoney(account.savingsBalance);
  if (selectElement('#accountNumber')) selectElement('#accountNumber').textContent = account.accountNumber || '';
  if (selectElement('#checkingLast4')) selectElement('#checkingLast4').textContent = account.accountNumber ? account.accountNumber.slice(-4) : '0000';
  if (selectElement('#savingsLast4')) {
    selectElement('#savingsLast4').textContent = account.savingsAccountNumber
      ? account.savingsAccountNumber.slice(-4) : (account.accountNumber ? account.accountNumber.slice(-4) : '0000');
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ 
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' 
  }[char]));
}

function renderTransactions(transactions) {
  const body = selectElement('#transactionsBody');
  if (!body) return;
  
  if (!transactions || !transactions.length) {
    body.innerHTML = '<tr><td colspan="4" style="text-align: center; color: #64748B; padding: 20px;">No historical accounting actions found on statement ledger.</td></tr>';
    return;
  }
  
  body.innerHTML = transactions.map(tx => {
    if (!tx) return '';
    const amount = Number(tx.amount || 0);
    const positive = amount >= 0;
    const rawDate = tx.createdAt || tx.dateTime;
    const date = rawDate ? new Date(rawDate).toLocaleString() : new Date().toLocaleString();
    const accountLabel = tx.accountType ? ` · ${tx.accountType.toUpperCase()}` : '';
    
    return `<tr>
      <td><strong>${escapeHtml(tx.type || 'Transaction')}${escapeHtml(accountLabel)}</strong><br><small style="color:#64748B;">ID: ${escapeHtml(tx.id || 'N/A')}</small></td>
      <td>${escapeHtml(tx.description || 'Processed Service')}</td>
      <td>${escapeHtml(date)}</td>
      <td class="amt-col ${positive ? 'pos-amt' : ''}">${positive ? '+' : ''}${formatMoney(amount)}</td>
    </tr>`;
  }).join('');
}

async function refreshDashboard() {
  try {
    const [me, activity] = await Promise.all([api('/api/me'), api('/api/transactions')]);
    if (me && me.account) {
      renderAccount(me.account);
    }
    if (activity && activity.transactions) {
      renderTransactions(activity.transactions);
    }
  } catch (err) {
    console.error('Failed to update dashboard fields:', err);
  }
}

async function tryRestoreSession() {
  try { 
    await refreshDashboard(); 
    const testMe = await api('/api/me');
    if (testMe && testMe.account) {
      showDashboard(); 
    } else {
      showLogin();
    }
  } catch { 
    showLogin(); 
  }
}

if (selectElement('#loginForm')) {
  selectElement('#loginForm').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button[type=submit]');
    const error = selectElement('#loginError');
    const userField = selectElement('#username');
    const passField = selectElement('#password');
    
    if (error) error.textContent = '';
    if (!userField || !passField || !userField.value || !passField.value) {
      if (error) error.textContent = 'Please type your account access credentials.';
      return;
    }
    
    if (button) button.disabled = true;
    try {
      const result = await api('/api/auth/login', { 
        method: 'POST', 
        body: JSON.stringify({ 
          username: userField.value.trim(), 
          password: passField.value 
        }) 
      });
      
      if (result && result.account) {
        renderAccount(result.account);
        await refreshDashboard();
        showDashboard();
      } else {
        throw new Error('Server returned an empty profile handshake response.');
      }
    } catch (err) { 
      if (error) error.textContent = err.message || 'Invalid username or account password entry.'; 
    } finally { 
      if (button) button.disabled = false; 
    }
  });
}

function submitTransaction(formSelector, endpoint, getPayload) {
  const form = selectElement(formSelector);
  if (!form) return;
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const button = form.querySelector('button[type=submit]');
    if (button) button.disabled = true;
    try {
      const result = await api(endpoint, { method: 'POST', body: JSON.stringify(getPayload()) });
      if (result && result.account) {
        renderAccount(result.account);
        await refreshDashboard();
        form.reset();
        showToast(result.message || 'Transaction successfully updated.');
      }
    } catch (err) { 
      showToast(err.message, true); 
    } finally { 
      if (button) button.disabled = false; 
    }
  });
}

submitTransaction('#depositForm', '/api/deposit', () => {
  const depAmt = selectElement('#depositAmount');
  const depType = selectElement('#depositAccountType');
  return { amount: depAmt ? Number(depAmt.value) : 0, accountType: depType ? depType.value : 'checking' };
});

submitTransaction('#withdrawForm', '/api/withdraw', () => {
  const witAmt = selectElement('#withdrawAmount');
  const witType = selectElement('#withdrawAccountType');
  return { amount: witAmt ? Number(witAmt.value) : 0, accountType: witType ? witType.value : 'checking' };
});

submitTransaction('#transferForm', '/api/transfer', () => {
  const trfRec = selectElement('#recipientAccount');
  const trfAmt = selectElement('#transferAmount');
  const trfType = selectElement('#transferAccountType');
  return { recipientAccount: trfRec ? trfRec.value.trim() : '', amount: trfAmt ? Number(trfAmt.value) : 0, accountType: trfType ? trfType.value : 'checking' };
});

if (selectElement('#refreshBtn')) {
  selectElement('#refreshBtn').addEventListener('click', async () => {
    try { await refreshDashboard(); showToast('Ledger successfully updated.'); }
    catch (err) { showToast(err.message, true); }
  });
}

if (selectElement('#logoutBtn')) {
  selectElement('#logoutBtn').addEventListener('click', async () => {
    try { await api('/api/auth/logout', { method: 'POST', body: '{}' }); }
    finally { if (selectElement('#loginForm')) selectElement('#loginForm').reset(); showLogin(); }
  });
}

tryRestoreSession();
