import type { NextConfig } from "next";

const config: NextConfig = {
  // The console never talks to the database; it is an API consumer like any other
  // (TDD §14.1). This is the only place the API's address is configured.
  env: { API_BASE_URL: process.env.API_BASE_URL ?? "http://localhost:8000" },
};

export default config;
