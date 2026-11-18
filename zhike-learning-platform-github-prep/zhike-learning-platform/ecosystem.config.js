module.exports = {
  apps: [{
    name: 'zhike-server',
    script: 'server.js',
    cwd: './',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '300M',
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
      JWT_SECRET: process.env.JWT_SECRET,
      ADMIN_USERNAME: process.env.ADMIN_USERNAME,
      ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
      ZHIKE_FALLBACK_API_KEY: process.env.ZHIKE_FALLBACK_API_KEY
    }
  }]
};
