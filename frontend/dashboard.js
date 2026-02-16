document.getElementById('uploadBtn').addEventListener('click', async () => {
  const body = {
    id: document.getElementById('designId').value,
    name: document.getElementById('designName').value,
    price: parseInt(document.getElementById('designPrice').value),
    logoLayer: document.getElementById('logoLayer').value,
    groups: JSON.parse(document.getElementById('groups').value),
    template: JSON.parse(document.getElementById('templateJson').value)
  }

  const res = await fetch('/api/upload-design', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-id': 'YOUR_TELEGRAM_ID' },
    body: JSON.stringify(body)
  })

  alert(await res.json().then(r => JSON.stringify(r)))
})