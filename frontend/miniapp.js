let logoSvg = '', logoColor = '#000000', logoScale = 1

document.getElementById('logoInput').addEventListener('change', async e => {
  const file = e.target.files[0]
  logoSvg = await file.text()
})
document.getElementById('logoColor').addEventListener('input', e => logoColor = e.target.value)
document.getElementById('logoScale').addEventListener('input', e => logoScale = e.target.value)

document.getElementById('nextBtn').addEventListener('click', async () => {
  const designs = await fetch('/api/designs').then(r => r.json())
  console.log('Available designs:', designs)
  alert('Check console for available designs')
})