module.exports = {
  apps: [
    {
      name: 'wa-gateway',
      script: 'src/server.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '450M',
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
