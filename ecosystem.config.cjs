// pm2 process file: `pm2 start ecosystem.config.cjs`
module.exports = {
  apps: [
    {
      name: 'soleye',
      script: 'dist/index.js',
      cwd: __dirname,
      instances: 1, // must be 1: SQLite + Telegram long polling
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 50,
      exp_backoff_restart_delay: 2000,
      max_memory_restart: '400M',
      kill_timeout: 35000, // let graceful shutdown finish
      env: { NODE_ENV: 'production' },
    },
  ],
};
