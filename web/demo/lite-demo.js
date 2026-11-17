// demo/lite.html: abre una imagen en grande con TeselaLite.decodeToURL.
document.getElementById('open').addEventListener('click', async () => {
  const dlg = document.getElementById('lb');
  const img = dlg.querySelector('img');
  img.src = await TeselaLite.decodeToURL('kodim05.tsl');
  dlg.showModal();
});
document.getElementById('lb').addEventListener('click', (ev) => ev.currentTarget.close());
