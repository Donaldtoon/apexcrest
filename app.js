const $ = selector => document.querySelector(selector);
const loginView = $('#loginView');
const dashboardView = $('#dashboardView');
let toastTimer;

function formatMoney(value) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(value));
}
async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || 'Something went wrong. Please try again.');
  return body;
}
function showToast(message, isError = false) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.toggle('error', isError);
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3500);
}
function showLogin() { dashboardView.classList.add('hidden'); loginView.classList.remove('hidden'); }
function showDashboard() { loginView.classList.add('hidden'); dashboardView.classList.remove('hidden'); }
function renderAccount(account) {
  $('#memberName').textContent = account.name;
  $('#balanceValue').textContent = formatMoney(account.balance);
  $('#accountType').textContent = account.accountType;
  $('#accountNumber').textContent = account.accountNumber;
  $('#accountLast4').textContent = account.accountNumber.slice(-4);
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
function renderTransactions(transactions) {
  const body = $('#transactionsBody');
  if (!transactions.length) {
    body.innerHTML = '<tr><td colspan="4" class="empty-state">No activity yet. Make a transaction to see it here.</td></tr>';
    return;
  }
  body.innerHTML = transactions.map(tx => {
    const amount = Number(tx.amount);
    const positive = amount >= 0;
    const date = new Date(tx.createdAt).toLocaleString();
    return `<tr><td><div class="transaction-type">${escapeHtml(tx.type)}</div><div class="transaction-id">${escapeHtml(tx.id)}</div></td><td>${escapeHtml(tx.description)}</td><td>${escapeHtml(date)}</td><td class="amount ${positive ? 'positive' : 'negative'}">${positive ? '+' : '−'}${formatMoney(Math.abs(amount))}</td></tr>`;
  }).join('');
}
async function refreshDashboard() {
  const [me, activity] = await Promise.all([api('/api/me'), api('/api/transactions')]);
  renderAccount(me.account);
  renderTransactions(activity.transactions);
}
async function tryRestoreSession() {
  try { await refreshDashboard(); showDashboard(); }
  catch { showLogin(); }
}

$('#loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type=submit]');
  const error = $('#loginError');
  error.textContent = '';
  button.disabled = true;
  try {
    const result = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: $('#username').value, password: $('#password').value }) });
    renderAccount(result.account);
    await refreshDashboard();
    showDashboard();
  } catch (err) { error.textContent = err.message; }
  finally { button.disabled = false; }
});


function submitTransaction(formSelector, endpoint, getPayload) {
  const form = $(formSelector);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const button = form.querySelector('button[type=submit]');
    button.disabled = true;
    try {
      const result = await api(endpoint, { method: 'POST', body: JSON.stringify(getPayload()) });
      renderAccount(result.account);
      await refreshDashboard();
      form.reset();
      showToast(result.message || 'Transaction recorded in the simulation.');
    } catch (err) { showToast(err.message, true); }
    finally { button.disabled = false; }
  });
}
submitTransaction('#depositForm', '/api/transactions/deposit', () => ({ amount: Number($('#depositAmount').value) }));
submitTransaction('#withdrawForm', '/api/transactions/withdraw', () => ({ amount: Number($('#withdrawAmount').value) }));
submitTransaction('#transferForm', '/api/transactions/transfer', () => ({ accountNumber: $('#recipientAccount').value, amount: Number($('#transferAmount').value) }));

$('#refreshBtn').addEventListener('click', async () => {
  try { await refreshDashboard(); showToast('Activity refreshed.'); }
  catch (err) { showToast(err.message, true); }
});
$('#logoutBtn').addEventListener('click', async () => {
  try { await api('/api/auth/logout', { method: 'POST', body: '{}' }); }
  finally { $('#loginForm').reset(); showLogin(); }
});
tryRestoreSession();
