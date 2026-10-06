'use strict';
(function () {
  const ORDER = ['dashboard', 'entry', 'data', 'export', 'settings', 'about'];
  let current = null;

  ST.show = async function show(name) {
    current = name;
    const view = document.getElementById('view');
    document.querySelectorAll('#tabs button').forEach((b) => { const on = b.dataset.tab === name; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
    try {
      await ST.refreshCore();
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
      else if (e.ctrlKey && /^[1-6]$/.test(e.key)) { e.preventDefault(); ST.show(ORDER[Number(e.key) - 1]); }
    });
    window.api.onAutoReport((file) => ST.toast(`Weekly report created: ${file}`));
    window.addEventListener('error', (e) => ST.fail(e.error || e.message));
    window.addEventListener('unhandledrejection', (e) => ST.fail(e.reason));
    const start = new URLSearchParams(location.search).get('tab');
    await ST.show(ORDER.includes(start) ? start : 'dashboard');
  }
  document.addEventListener('DOMContentLoaded', boot);
})();
