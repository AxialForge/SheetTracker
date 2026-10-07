'use strict';
(function () {
  const ORDER = ['dashboard', 'entry', 'data', 'export', 'forms', 'settings', 'about'];
  let current = null;

  // Top-right: which profile (job) is open, and a quick way to change it when there is more than one.
  function renderStatus() {
    const box = document.getElementById('status');
    const profs = ST.state.profiles || [];
    const cur = profs.find((p) => p.id === ST.state.profileId);
    document.getElementById('brand-sub').textContent = cur ? cur.name : '';
    box.replaceChildren();
    if (profs.length < 2) return;
    const sel = ST.select(profs.map((p) => [p.id, p.name]), ST.state.profileId, { class: 'profile-sel', 'aria-label': 'Open profile', title: 'Switch profile (job)',
      onchange: async (e) => { try { await ST.main('profile:switch', e.target.value); } catch (err) { ST.fail(err); e.target.value = ST.state.profileId; } } });
    box.append(sel);
  }

  ST.show = async function show(name) {
    current = name;
    const view = document.getElementById('view');
    document.querySelectorAll('#tabs button').forEach((b) => { const on = b.dataset.tab === name; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
    try {
      await ST.refreshCore();
      renderStatus();
      view.className = `view v-${name}`;
      view.scrollTop = 0;
      await ST.tabs[name].render(view);
    } catch (e) { ST.fail(e); }
  };

  async function boot() {
    const nav = document.getElementById('tabs');
    ORDER.forEach((k, i) => nav.append(ST.h('button', { role: 'tab', 'data-tab': k, title: `Ctrl+${i + 1}`, text: ST.tabs[k].title, onclick: () => ST.show(k) })));
    window.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.key === 's') { e.preventDefault(); if (current === 'entry') ST.tabs.entry.save(); }
      else if (e.ctrlKey && /^[1-7]$/.test(e.key)) { e.preventDefault(); ST.show(ORDER[Number(e.key) - 1]); }
    });
    window.api.onAutoReport((file) => ST.toast(`Weekly report created: ${file}`));
    window.addEventListener('error', (e) => ST.fail(e.error || e.message));
    window.addEventListener('unhandledrejection', (e) => ST.fail(e.reason));
    const start = new URLSearchParams(location.search).get('tab');
    await ST.show(ORDER.includes(start) ? start : 'dashboard');
  }
  document.addEventListener('DOMContentLoaded', boot);
})();
