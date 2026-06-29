chrome.storage.local.get({ totalSent: 0 }, (d) => {
  document.getElementById('total').textContent = d.totalSent || 0;
});
