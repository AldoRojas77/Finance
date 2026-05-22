/* ========== FinanzasApp - app.js ========== */
'use strict';

const MONTHS_ES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
const KEYS = { TX: 'finapp_transactions', BANKS: 'finapp_banks', CATS: 'finapp_categories' };

// ==================== STATE ====================
let state = { transactions: [], banks: [], categories: [] };

function load() {
  state.transactions = JSON.parse(localStorage.getItem(KEYS.TX) || '[]');
  state.banks = JSON.parse(localStorage.getItem(KEYS.BANKS) || '[]');
  state.categories = JSON.parse(localStorage.getItem(KEYS.CATS) || '[]');
}
function saveTx() { localStorage.setItem(KEYS.TX, JSON.stringify(state.transactions)); }
function saveBanks() { localStorage.setItem(KEYS.BANKS, JSON.stringify(state.banks)); }
function saveCats() { localStorage.setItem(KEYS.CATS, JSON.stringify(state.categories)); }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function fmt(n) { return new Intl.NumberFormat('es-MX', { style:'currency', currency:'MXN' }).format(n); }
function fmtDate(d) {
  if (!d || typeof d !== 'string') return '—';
  const [y,m,day] = d.split('-');
  const mi = parseInt(m) - 1;
  if (isNaN(mi) || mi < 0 || mi > 11) return d;
  return `${parseInt(day)} ${MONTHS_ES[mi].slice(0,3)} ${y}`;
}
function isValidDate(dateStr) {
  if (!dateStr) return false;
  const d = new Date(dateStr + 'T12:00:00');
  return !isNaN(d.getTime()) && d.getFullYear() > 1900 && d.getFullYear() < 2200;
}

// ==================== CREDIT CARD LOGIC ====================
function determinePaymentMonth(dateStr, cutoffDay) {
  const date = new Date(dateStr + 'T12:00:00');
  const txDay = date.getDate();
  let month = date.getMonth();
  let year = date.getFullYear();
  if (txDay > cutoffDay) {
    month++;
    if (month > 11) { month = 0; year++; }
  }
  return { month, year };
}

function getEffectiveMonth(tx) {
  if (!tx.isIncome && tx.paymentType === 'credit') {
    const bank = state.banks.find(b => b.id === tx.bankId);
    if (bank && bank.cutoffDay) return determinePaymentMonth(tx.date, bank.cutoffDay);
  }
  const d = new Date(tx.date + 'T12:00:00');
  const m = d.getMonth();
  const y = d.getFullYear();
  if (isNaN(m) || isNaN(y)) return { month: 0, year: 2026 };
  return { month: m, year: y };
}

function getPaymentLabel(tx) {
  const em = getEffectiveMonth(tx);
  const monthName = MONTHS_ES[em.month] || '???';
  return `${monthName.slice(0,3)} ${em.year}`;
}

// ==================== INSTALLMENT HELPERS ====================
function advanceMonth(month, year, n) {
  let m = month + n;
  let y = year;
  while (m > 11) { m -= 12; y++; }
  while (m < 0) { m += 12; y--; }
  return { month: m, year: y };
}

function getInstallmentMonths(tx) {
  const installments = tx.installments || 1;
  const startMonth = getEffectiveMonth(tx);
  const months = [];
  for (let i = 0; i < installments; i++) {
    months.push(advanceMonth(startMonth.month, startMonth.year, i));
  }
  return months;
}

// ==================== SUMMARY CALCULATOR ====================
function calcMonthlySummary() {
  const map = {};
  state.transactions.forEach(tx => {
    const installments = tx.installments || 1;
    const bankName = tx.paymentType === 'cash' ? 'Efectivo' : (state.banks.find(b => b.id === tx.bankId)?.name || 'Sin banco');

    if (installments > 1 && tx.paymentType === 'credit' && !tx.isIncome) {
      // Distribute MSI across months
      const monthlyAmount = tx.amount / installments;
      const startMonth = getEffectiveMonth(tx);
      for (let i = 0; i < installments; i++) {
        const em = advanceMonth(startMonth.month, startMonth.year, i);
        const key = `${em.year}-${String(em.month).padStart(2,'0')}`;
        if (!map[key]) map[key] = { month: em.month, year: em.year, income: 0, expenses: 0, byBank: {} };
        const entry = map[key];
        entry.expenses += monthlyAmount;
        if (!entry.byBank[bankName]) entry.byBank[bankName] = { credit: 0, debit: 0, cash: 0, income: 0 };
        entry.byBank[bankName].credit += monthlyAmount;
      }
    } else {
      // Normal single-payment transaction
      const em = getEffectiveMonth(tx);
      const key = `${em.year}-${String(em.month).padStart(2,'0')}`;
      if (!map[key]) map[key] = { month: em.month, year: em.year, income: 0, expenses: 0, byBank: {} };
      const entry = map[key];

      const cat = state.categories.find(c => c.id === tx.categoryId);
      const isCcPayment = cat && cat.linkedBankId && !tx.isIncome;
      const targetCcBank = isCcPayment ? state.banks.find(b => b.id === cat.linkedBankId)?.name : null;

      if (tx.isIncome) {
        entry.income += tx.amount;
        if (!entry.byBank[bankName]) entry.byBank[bankName] = { credit: 0, debit: 0, cash: 0, income: 0 };
        entry.byBank[bankName].income += tx.amount;
      } else if (isCcPayment && targetCcBank) {
        // Deduct from the credit card's debt without adding to monthly expenses
        if (!entry.byBank[targetCcBank]) entry.byBank[targetCcBank] = { credit: 0, debit: 0, cash: 0, income: 0 };
        entry.byBank[targetCcBank].credit -= tx.amount;
        // The source (debit/cash) is still recorded so the cash flow balances
        if (!entry.byBank[bankName]) entry.byBank[bankName] = { credit: 0, debit: 0, cash: 0, income: 0 };
        if (tx.paymentType === 'cash') entry.byBank[bankName].cash += tx.amount;
        else if (tx.paymentType === 'debit') entry.byBank[bankName].debit += tx.amount;
      } else {
        entry.expenses += tx.amount;
        if (!entry.byBank[bankName]) entry.byBank[bankName] = { credit: 0, debit: 0, cash: 0, income: 0 };
        if (tx.paymentType === 'credit') entry.byBank[bankName].credit += tx.amount;
        else if (tx.paymentType === 'cash') entry.byBank[bankName].cash += tx.amount;
        else entry.byBank[bankName].debit += tx.amount;
      }
    }
  });
  return Object.entries(map).sort(([a],[b]) => a.localeCompare(b)).map(([,v]) => v);
}

// ==================== RENDERING ====================
function renderSummaryCards() {
  let totalIncome = 0, totalExpenses = 0;
  state.transactions.forEach(tx => {
    if (tx.isIncome) {
      totalIncome += tx.amount;
    } else {
      const cat = state.categories.find(c => c.id === tx.categoryId);
      const isCcPayment = cat && cat.linkedBankId;
      if (!isCcPayment) {
        totalExpenses += tx.amount;
      }
    }
  });
  document.getElementById('total-income').textContent = fmt(totalIncome);
  document.getElementById('total-expenses').textContent = fmt(totalExpenses);
  const bal = totalIncome - totalExpenses;
  const balEl = document.getElementById('total-balance');
  balEl.textContent = fmt(bal);
  balEl.style.color = bal >= 0 ? 'var(--blue)' : 'var(--red)';
}

function renderMonthlyGlobal() {
  const container = document.getElementById('monthly-global');
  const data = calcMonthlySummary();
  if (!data.length) {
    container.innerHTML = '<div class="empty-state"><span class="empty-icon">📊</span><p>Agrega transacciones para ver el resumen mensual</p></div>';
    return;
  }
  // Aggregate all-time totals
  let totalIncome = 0, totalExpenses = 0;
  state.transactions.forEach(tx => {
    if (tx.isIncome) {
      totalIncome += tx.amount;
    } else {
      const cat = state.categories.find(c => c.id === tx.categoryId);
      const isCcPayment = cat && cat.linkedBankId;
      if (!isCcPayment) {
        totalExpenses += tx.amount;
      }
    }
  });
  const totalBalance = totalIncome - totalExpenses;
  const balClass = totalBalance >= 0 ? 'positive' : 'negative';
  container.innerHTML = `
    <div class="month-metrics" style="margin-bottom:0">
      <div class="month-metric income">
        <div class="month-metric-label">Total Ingresos</div>
        <div class="month-metric-value">+${fmt(totalIncome)}</div>
      </div>
      <div class="month-metric expense">
        <div class="month-metric-label">Total Egresos</div>
        <div class="month-metric-value">-${fmt(totalExpenses)}</div>
      </div>
    </div>
    <div class="monthly-balance-row">
      <span class="monthly-balance-label">Balance General</span>
      <span class="monthly-balance-value ${balClass}">${fmt(totalBalance)}</span>
    </div>
    <div class="monthly-months-count">${data.length} ${data.length === 1 ? 'mes registrado' : 'meses registrados'} — clic para ver detalle</div>
  `;
}

function renderMonthlyDetail() {
  const container = document.getElementById('monthly-summary-detail');
  const data = calcMonthlySummary();
  if (!data.length) {
    container.innerHTML = '<div class="empty-state"><span class="empty-icon">📊</span><p>No hay datos</p></div>';
    return;
  }
  container.innerHTML = data.map((m, i) => {
    const balance = m.income - m.expenses;
    const bankRows = Object.entries(m.byBank).map(([name, v]) => {
      const parts = [];
      if (v.credit > 0) parts.push(`<span class="bank-credit">${fmt(v.credit)}</span>`);
      if (v.debit > 0) parts.push(`<span class="bank-debit">${fmt(v.debit)}</span>`);
      if (v.cash > 0) parts.push(`<span style="color:var(--text-primary);font-size:.8rem">${fmt(v.cash)}</span>`);
      if (v.income > 0) parts.push(`<span style="color:var(--green);font-size:.8rem">${fmt(v.income)}</span>`);
      return `<div class="bank-row"><span class="bank-row-name">${name}</span><div class="bank-row-amounts">${parts.join('')}</div></div>`;
    }).join('');
    return `<div class="month-card" style="animation-delay:${i * .08}s">
      <div class="month-card-header">
        <span class="month-card-title">📅 ${MONTHS_ES[m.month]}<span class="month-year">${m.year}</span></span>
        <span class="month-card-balance ${balance >= 0 ? 'positive' : 'negative'}">${fmt(balance)}</span>
      </div>
      <div class="month-metrics">
        <div class="month-metric income"><div class="month-metric-label">Ingresos</div><div class="month-metric-value">+${fmt(m.income)}</div></div>
        <div class="month-metric expense"><div class="month-metric-label">Egresos</div><div class="month-metric-value">-${fmt(m.expenses)}</div></div>
      </div>
      ${bankRows ? `<div class="month-bank-breakdown"><div class="month-bank-breakdown-title">Desglose por banco</div>${bankRows}</div>` : ''}
    </div>`;
  }).join('');
}

function renderTransactions() {
  const tbody = document.getElementById('transactions-body');
  const emptyEl = document.getElementById('table-empty');
  const filterMonth = document.getElementById('filter-month').value;
  const filterType = document.getElementById('filter-type').value;

  let txs = [...state.transactions].sort((a,b) => b.date.localeCompare(a.date));
  if (filterType === 'income') txs = txs.filter(t => t.isIncome);
  else if (filterType === 'expense') txs = txs.filter(t => !t.isIncome);
  if (filterMonth !== 'all') {
    txs = txs.filter(t => {
      const em = getEffectiveMonth(t);
      return `${em.year}-${String(em.month).padStart(2,'0')}` === filterMonth;
    });
  }

  if (!txs.length) {
    tbody.innerHTML = '';
    emptyEl.style.display = 'block';
    return;
  }
  emptyEl.style.display = 'none';
  tbody.innerHTML = txs.map(tx => {
    const cat = state.categories.find(c => c.id === tx.categoryId);
    const bank = state.banks.find(b => b.id === tx.bankId);
    const catLabel = cat ? `${cat.icon} ${cat.name}` : '—';
    const bankLabel = tx.paymentType === 'cash' ? '—' : (bank ? bank.name : '—');
    let typeBadge;
    if (tx.paymentType === 'credit') {
      const inst = tx.installments || 1;
      const msiLabel = inst > 1 ? ` ${inst}MSI` : '';
      typeBadge = `<span class="badge badge-credit">Crédito${msiLabel}</span>`;
    } else if (tx.paymentType === 'cash') {
      typeBadge = '<span class="badge badge-cash">Efectivo</span>';
    } else {
      typeBadge = '<span class="badge badge-debit">Débito</span>';
    }
    const amountClass = tx.isIncome ? 'amount-income' : 'amount-expense';
    const amountPrefix = tx.isIncome ? '+' : '-';
    // For MSI, show monthly amount and payment range
    let msiInfo = '';
    if ((tx.installments || 1) > 1 && tx.paymentType === 'credit') {
      const monthly = tx.amount / tx.installments;
      msiInfo = `<div class="msi-detail">${fmt(monthly)}/mes × ${tx.installments}</div>`;
    }
    return `<tr>
      <td>${fmtDate(tx.date)}</td>
      <td>${tx.description || '—'}${msiInfo}</td>
      <td>${catLabel}</td>
      <td>${bankLabel}</td>
      <td>${typeBadge}</td>
      <td class="${amountClass}">${amountPrefix}${fmt(tx.amount)}</td>
      <td>${getPaymentLabel(tx)}</td>
      <td><button class="btn-delete" data-id="${tx.id}" title="Eliminar">🗑</button></td>
    </tr>`;
  }).join('');
}

function renderBankOptions() {
  const sel = document.getElementById('tx-bank');
  const val = sel.value;
  sel.innerHTML = '<option value="">Seleccionar banco...</option>' +
    state.banks.map(b => {
      const typeLabel = b.cardType === 'debit' ? 'Débito' : 'Crédito';
      const cutoffLabel = b.cutoffDay ? ` · corte: ${b.cutoffDay}` : '';
      const payLabel = b.paymentDay ? ` · pago: ${b.paymentDay}` : '';
      return `<option value="${b.id}">${b.name} (${typeLabel}${cutoffLabel}${payLabel})</option>`;
    }).join('');
  sel.value = val;
}

function renderCategoryOptions() {
  const sel = document.getElementById('tx-category');
  const val = sel.value;
  sel.innerHTML = '<option value="">Seleccionar categoría...</option>' +
    state.categories.map(c => `<option value="${c.id}">${c.icon} ${c.name}</option>`).join('');
  sel.value = val;
}

function renderBanksList() {
  const container = document.getElementById('banks-list');
  if (!state.banks.length) { container.innerHTML = '<p class="empty-text">No hay bancos registrados. Agrega uno para empezar.</p>'; return; }
  container.innerHTML = state.banks.map(b => {
    const typeLabel = b.cardType === 'debit' ? '💳 Débito' : '💳 Crédito';
    const cutoffLabel = b.cutoffDay ? ` · Corte: día ${b.cutoffDay}` : '';
    const payLabel = b.paymentDay ? ` · Pago: día ${b.paymentDay}` : '';
    return `
    <div class="settings-item">
      <div class="settings-item-info">
        <span class="settings-item-name">🏦 ${b.name}</span>
        <span class="settings-item-detail">${typeLabel}${cutoffLabel}${payLabel}</span>
      </div>
      <button class="btn-delete" data-bank-id="${b.id}" title="Eliminar">🗑</button>
    </div>`;
  }).join('');
}

function renderCategoriesList() {
  const container = document.getElementById('categories-list');
  if (!state.categories.length) { container.innerHTML = '<p class="empty-text">No hay categorías registradas.</p>'; return; }
  container.innerHTML = state.categories.map(c => `
    <div class="settings-item">
      <div class="settings-item-info">
        <span>${c.icon} ${c.name}${c.linkedBankId ? ' <span style="font-size:.7rem;color:var(--purple);">(Pago Tarjeta)</span>' : ''}</span>
      </div>
      <button class="btn-delete" data-cat-id="${c.id}" title="Eliminar">🗑</button>
    </div>`).join('');
}

function renderCategoryLinkBankOptions() {
  const select = document.getElementById('category-link-bank');
  const creditBanks = state.banks.filter(b => b.cardType === 'credit');
  select.innerHTML = '<option value="">No aplica</option>' + creditBanks.map(b => `<option value="${b.id}">${b.name}</option>`).join('');
}

function updateFilterMonths() {
  const sel = document.getElementById('filter-month');
  const current = sel.value;
  const months = new Set();
  state.transactions.forEach(tx => {
    const em = getEffectiveMonth(tx);
    months.add(`${em.year}-${String(em.month).padStart(2,'0')}`);
  });
  const sorted = [...months].sort();
  sel.innerHTML = '<option value="all">Todos los meses</option>' +
    sorted.map(k => {
      const [y, m] = k.split('-');
      return `<option value="${k}">${MONTHS_ES[parseInt(m)]} ${y}</option>`;
    }).join('');
  sel.value = current;
}

function updateCreditInfo() {
  const box = document.getElementById('credit-info');
  const text = document.getElementById('credit-info-text');
  const payType = getToggleValue('payment-type-toggle');
  if (payType !== 'credit') { box.classList.remove('visible'); return; }
  box.classList.add('visible');
  const bankId = document.getElementById('tx-bank').value;
  const dateVal = document.getElementById('tx-date').value;
  if (!bankId || !dateVal) { text.textContent = 'Selecciona banco y fecha para ver el mes de pago.'; return; }
  const bank = state.banks.find(b => b.id === bankId);
  if (!bank) return;
  const pm = determinePaymentMonth(dateVal, bank.cutoffDay);
  const installments = parseInt(document.getElementById('tx-installments').value) || 1;
  const payDayLabel = bank.paymentDay ? ` · Día de pago: ${bank.paymentDay}` : '';
  let infoText = `Corte: día ${bank.cutoffDay}${payDayLabel} → Pago en ${MONTHS_ES[pm.month]} ${pm.year}`;
  if (installments > 1) {
    const lastMonth = advanceMonth(pm.month, pm.year, installments - 1);
    infoText += ` | MSI: ${installments} pagos de ${MONTHS_ES[pm.month].slice(0,3)} ${pm.year} a ${MONTHS_ES[lastMonth.month].slice(0,3)} ${lastMonth.year}`;
  }
  text.textContent = infoText;
}

function updateMsiVisibility() {
  const payType = getToggleValue('payment-type-toggle');
  const msiRow = document.getElementById('msi-row');
  if (payType === 'credit') {
    msiRow.style.display = '';
  } else {
    msiRow.style.display = 'none';
    document.getElementById('tx-installments').value = '1';
  }
}

function refreshAll() {
  renderSummaryCards();
  renderMonthlyGlobal();
  renderMonthlyDetail();
  renderTransactions();
  renderBankOptions();
  renderCategoryOptions();
  updateFilterMonths();
  updateCreditInfo();
}

// ==================== EVENT HANDLERS ====================
function getToggleValue(id) {
  return document.getElementById(id).querySelector('.toggle-btn.active')?.dataset.value;
}

function setupToggles() {
  document.querySelectorAll('.toggle-buttons').forEach(group => {
    group.querySelectorAll('.toggle-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        group.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        updateCreditInfo();
      });
    });
  });
}

function setupModalTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(btn.dataset.tab).classList.add('active');
    });
  });
}

function setupModal() {
  const modal = document.getElementById('settings-modal');
  document.getElementById('btn-open-settings').addEventListener('click', () => modal.classList.add('active'));
  document.getElementById('btn-close-settings').addEventListener('click', () => modal.classList.remove('active'));
  modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('active'); });
}

function setupMonthlySheet() {
  const sheet = document.getElementById('monthly-sheet');
  document.getElementById('btn-open-monthly-sheet').addEventListener('click', () => {
    sheet.classList.add('active');
  });
  document.getElementById('btn-close-monthly-sheet').addEventListener('click', () => {
    sheet.classList.remove('active');
  });
  sheet.addEventListener('click', e => {
    if (e.target === sheet) sheet.classList.remove('active');
  });
}

function updateBankFieldVisibility() {
  const payType = getToggleValue('payment-type-toggle');
  const bankGroup = document.getElementById('tx-bank').closest('.form-group');
  if (payType === 'cash') {
    bankGroup.style.display = 'none';
    document.getElementById('tx-bank').removeAttribute('required');
  } else {
    bankGroup.style.display = '';
    document.getElementById('tx-bank').setAttribute('required', '');
  }
  updateMsiVisibility();
}

function setupForm() {
  const form = document.getElementById('transaction-form');
  document.getElementById('tx-date').valueAsDate = new Date();
  form.addEventListener('submit', e => {
    e.preventDefault();
    const paymentType = getToggleValue('payment-type-toggle');
    const bankId = paymentType === 'cash' ? '' : document.getElementById('tx-bank').value;
    const categoryId = document.getElementById('tx-category').value;
    const amount = parseFloat(document.getElementById('tx-amount').value);
    const date = document.getElementById('tx-date').value;
    const description = document.getElementById('tx-description').value.trim();
    const isIncome = getToggleValue('income-expense-toggle') === 'income';
    const installments = paymentType === 'credit' ? parseInt(document.getElementById('tx-installments').value) || 1 : 1;

    if (paymentType !== 'cash' && !bankId) { showToast('Selecciona un banco', 'error'); return; }
    if (!categoryId) { showToast('Selecciona una categoría', 'error'); return; }
    if (!amount || amount <= 0) { showToast('Ingresa un monto válido', 'error'); return; }
    if (!date || !isValidDate(date)) { showToast('Selecciona una fecha válida', 'error'); return; }

    state.transactions.push({ id: uid(), date, amount, bankId, paymentType, isIncome, categoryId, description, installments });
    saveTx();
    form.reset();
    document.getElementById('tx-date').valueAsDate = new Date();
    document.getElementById('tx-installments').value = '1';
    // Reset toggles to defaults
    document.querySelectorAll('#income-expense-toggle .toggle-btn').forEach(b => b.classList.toggle('active', b.dataset.value === 'expense'));
    document.querySelectorAll('#payment-type-toggle .toggle-btn').forEach(b => b.classList.toggle('active', b.dataset.value === 'debit'));
    updateBankFieldVisibility();
    refreshAll();
    showToast('Transacción agregada ✓', 'success');
  });
}

function updateCutoffFieldVisibility() {
  const cardType = document.getElementById('bank-card-type').value;
  const cutoffGroup = document.getElementById('bank-cutoff-group');
  const paymentGroup = document.getElementById('bank-payment-group');
  if (cardType === 'debit') {
    cutoffGroup.style.display = 'none';
    paymentGroup.style.display = 'none';
  } else {
    cutoffGroup.style.display = '';
    paymentGroup.style.display = '';
  }
}

function setupBanks() {
  // Toggle cutoff/payment field visibility based on card type
  const cardTypeSelect = document.getElementById('bank-card-type');
  cardTypeSelect.addEventListener('change', updateCutoffFieldVisibility);
  updateCutoffFieldVisibility();

  document.getElementById('btn-add-bank').addEventListener('click', () => {
    const nameEl = document.getElementById('bank-name');
    const cutoffEl = document.getElementById('bank-cutoff');
    const paymentDayEl = document.getElementById('bank-payment-day');
    const cardTypeEl = document.getElementById('bank-card-type');
    const name = nameEl.value.trim();
    const cardType = cardTypeEl.value;
    const cutoff = cardType === 'credit' ? parseInt(cutoffEl.value) : null;
    const paymentDay = cardType === 'credit' ? parseInt(paymentDayEl.value) : null;
    if (!name) { showToast('Ingresa el nombre del banco', 'error'); return; }
    if (cardType === 'credit' && (!cutoff || cutoff < 1 || cutoff > 31)) {
      showToast('Día de corte inválido (1-31)', 'error'); return;
    }
    if (cardType === 'credit' && (!paymentDay || paymentDay < 1 || paymentDay > 31)) {
      showToast('Día de pago inválido (1-31)', 'error'); return;
    }
    state.banks.push({ id: uid(), name, cardType, cutoffDay: cutoff, paymentDay });
    saveBanks();
    nameEl.value = ''; cutoffEl.value = ''; paymentDayEl.value = ''; cardTypeEl.value = 'credit';
    updateCutoffFieldVisibility();
    renderBanksList(); renderBankOptions(); updateCreditInfo();
    showToast(`Banco "${name}" agregado ✓`, 'success');
  });
  document.getElementById('banks-list').addEventListener('click', e => {
    const btn = e.target.closest('[data-bank-id]');
    if (!btn) return;
    const id = btn.dataset.bankId;
    const bank = state.banks.find(b => b.id === id);
    if (confirm(`¿Eliminar banco "${bank?.name}"?`)) {
      state.banks = state.banks.filter(b => b.id !== id);
      saveBanks(); renderBanksList(); renderBankOptions(); refreshAll();
      showToast('Banco eliminado', 'success');
    }
  });
}

function setupCategories() {
  const btn = document.getElementById('btn-add-category');
  const input = document.getElementById('category-name');
  const iconInput = document.getElementById('category-icon');
  const linkSelect = document.getElementById('category-link-bank');
  btn.addEventListener('click', () => {
    const v = input.value.trim();
    if (v) {
      state.categories.push({ id: uid(), name: v, icon: iconInput.value.trim() || '📂', linkedBankId: linkSelect.value || null });
      saveCats(); renderCategoriesList(); renderCategoryOptions(); input.value = ''; iconInput.value = ''; linkSelect.value = '';
      showToast(`Categoría "${v}" agregada ✓`, 'success');
    }
  });
  document.getElementById('categories-list').addEventListener('click', e => {
    const btn = e.target.closest('[data-cat-id]');
    if (!btn) return;
    const id = btn.dataset.catId;
    const cat = state.categories.find(c => c.id === id);
    if (confirm(`¿Eliminar categoría "${cat?.name}"?`)) {
      state.categories = state.categories.filter(c => c.id !== id);
      saveCats(); renderCategoriesList(); renderCategoryOptions();
      showToast('Categoría eliminada', 'success');
    }
  });
}

function setupDeleteTx() {
  document.getElementById('transactions-body').addEventListener('click', e => {
    const btn = e.target.closest('[data-id]');
    if (!btn) return;
    if (confirm('¿Eliminar esta transacción?')) {
      state.transactions = state.transactions.filter(t => t.id !== btn.dataset.id);
      saveTx(); refreshAll();
      showToast('Transacción eliminada', 'success');
    }
  });
}

function setupFilters() {
  document.getElementById('filter-month').addEventListener('change', renderTransactions);
  document.getElementById('filter-type').addEventListener('change', renderTransactions);
}

function setupCreditInfoWatchers() {
  document.getElementById('tx-bank').addEventListener('change', updateCreditInfo);
  document.getElementById('tx-date').addEventListener('change', updateCreditInfo);
}

function setupPaymentTypeWatcher() {
  // When payment type toggle changes, update bank field visibility and MSI
  const toggleGroup = document.getElementById('payment-type-toggle');
  toggleGroup.querySelectorAll('.toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      setTimeout(() => {
        updateBankFieldVisibility();
        updateCreditInfo();
      }, 10);
    });
  });
}

function setupMsiWatcher() {
  document.getElementById('tx-installments').addEventListener('change', updateCreditInfo);
}

// ==================== TOAST ====================
let toastTimer;
function showToast(msg, type) {
  const toast = document.getElementById('toast');
  document.getElementById('toast-icon').textContent = type === 'success' ? '✅' : '⚠️';
  document.getElementById('toast-message').textContent = msg;
  toast.className = `toast visible ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 3000);
}

// ==================== INIT ====================
function init() {
  load();
  setupToggles();
  setupModal();
  setupMonthlySheet();
  setupModalTabs();
  setupForm();
  setupBanks();
  setupCategories();
  setupDeleteTx();
  setupFilters();
  setupCreditInfoWatchers();
  setupPaymentTypeWatcher();
  setupMsiWatcher();
  renderBanksList();
  renderCategoryLinkBankOptions();
  renderCategoriesList();
  refreshAll();
  updateBankFieldVisibility();
}

document.addEventListener('DOMContentLoaded', init);
