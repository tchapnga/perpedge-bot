module.exports = {
  apps: [
    {
      name: 'perpedge-bot',
      script: 'index.js',
      interpreter: 'node',
      env_file: '.env',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      out_file: 'logs/out.log',
      error_file: 'logs/error.log',
      merge_logs: true,
      max_memory_restart: '300M',
      restart_delay: 5000,
      max_restarts: 20,
      watch: false,
      instances: 1,
      kill_timeout: 10000,
      cron_restart: '0 4 * * *',
      env_production: {
        NODE_ENV: 'production',
        BOT_MODE: 'LIVE',
        LLM_MODE: 'claude',
      },
    },
  ],
};
