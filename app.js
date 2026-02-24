const tg = window.Telegram.WebApp;
tg.expand();

const user = tg.initDataUnsafe.user;

const WORKER_URL = "https://your-worker.yourname.workers.dev";

// ===== LOGIN =====
async function login() {
  const res = await fetch(`${WORKER_URL}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      telegram_id: user.id,
      username: user.username
    })
  });

  const data = await res.json();

  document.getElementById("user").innerText =
    "Welcome " + data.username;

  document.getElementById("balance").innerText =
    "Balance: " + data.balance;
}

// ===== LOAD DESIGNS =====
async function loadDesigns() {
  const res = await fetch(`${WORKER_URL}/api/designs`);
  const designs = await res.json();

  const container = document.getElementById("designs");
  container.innerHTML = "";

  designs.forEach(d => {
    container.innerHTML += `
      <div class="design-card">
        <h4>${d.name}</h4>
        <p>Price: ${d.price}</p>
        <button onclick="alert('Next phase')">Select</button>
      </div>
    `;
  });
}

login();
loadDesigns();
