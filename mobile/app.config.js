// mobile/app.config.js
const base = require('./app.json');

module.exports = {
  ...base,
  expo: {
    ...base.expo,
    extra: {
      workerBaseUrl: process.env.WORKER_BASE_URL ?? '',
      workerApiKey: process.env.WORKER_API_KEY ?? '',
      splitwiseClientId: process.env.SPLITWISE_CLIENT_ID ?? '',
    },
  },
};
