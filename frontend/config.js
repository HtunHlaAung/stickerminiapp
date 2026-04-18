// frontend/config.js
// ⚠️  Update WORKER_URL after deploying your Cloudflare Worker
window.APP_CONFIG = {
  WORKER_URL:   'https://stickerminiapp-worker.YOUR_CF_SUBDOMAIN.workers.dev',
  APP_NAME:     'Magic Sticker',
  OWNER_ID:     '1849257766',
  MAX_FILE_SIZE: 64 * 1024,  // 64 KB
  TOPUP_AMOUNTS: [500,1000,1500,2000,2500,3000,3500,4000,4500,5000,
                  6000,7000,8000,9000,10000,15000,20000,25000,30000,40000,50000],
};
