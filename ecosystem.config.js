module.exports = {
  apps: [
    {
      name: "m_hosary",
      script: "index.js",
    },
  ],

  deploy: {
    production: {
      user: "root",
      host: "185.252.146.152",
      ref: "origin/auto",
      repo: "git@github.com:edhit/m_hosary.git",
      path: "/root/m_hosary",
      "post-deploy":
        "npm install && pm2 reload ecosystem.config.js --only m_hosary",
    },
  },
};
