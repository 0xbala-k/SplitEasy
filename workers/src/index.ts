export interface Env {
  PLAID_CLIENT_ID: string;
  PLAID_SECRET: string;
  PLAID_ENV: string;
  WORKER_API_KEY: string;
  SPLITWISE_CLIENT_ID: string;
  SPLITWISE_CLIENT_SECRET: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return new Response("OK");
  },
};
