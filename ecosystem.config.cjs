// ecosystem.config.cjs
module.exports = {
    apps: [
        {
            name: 'perpedge-bot',
            cwd: '/home/ubuntu/perpedge-bot',
            script: 'index.js',
            interpreter: 'node',
            exec_mode: 'fork',
            instances: 1,
            autorestart: true,
            watch: false,
            max_memory_restart: '512M',
            kill_timeout: 35000,
            listen_timeout: 10000,
            cron_restart: '',
            time: true,
            env: {
                NODE_ENV: 'production',
                PORT: '3001'
            },
            error_file: '/home/ubuntu/perpedge-bot/logs/perpedge-bot.err.log',
            out_file: '/home/ubuntu/perpedge-bot/logs/perpedge-bot.out.log',
            log_file: '/home/ubuntu/perpedge-bot/logs/perpedge-bot.combined.log',
            merge_logs: true
        }
    ]
};
