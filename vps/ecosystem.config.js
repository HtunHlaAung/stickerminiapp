module.exports = {
  apps: [{
    name:        "sticker-vps",
    script:      "src/server.js",
    cwd:         "/opt/sticker/vps",
    instances:   1,
    autorestart: true,
    watch:       false,
    max_memory_restart: "512M",
    env: {
      NODE_ENV: "production",
      PORT:     3000,
    },
    error_file: "/var/log/sticker/error.log",
    out_file:   "/var/log/sticker/out.log",
    log_date_format: "YYYY-MM-DD HH:mm:ss",
  }]
};
