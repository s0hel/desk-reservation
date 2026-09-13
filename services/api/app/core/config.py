from functools import lru_cache
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=(".env", "../../.env"), extra="ignore")

    environment: Literal["development", "staging", "production"] = "development"

    database_url: str = "postgresql+asyncpg://deskflow_app:deskflow@localhost:5432/deskflow"
    migration_database_url: str = (
        "postgresql+psycopg://deskflow_owner:deskflow@localhost:5432/deskflow"
    )
    redis_url: str = "redis://localhost:6379/0"

    jwt_signing_key: str = "dev-only-insecure-change-me"
    access_token_ttl_seconds: int = 900
    refresh_token_ttl_days: int = 30

    api_base_url: str = "http://localhost:8000"
    app_redirect_uri: str = "deskflow://auth/callback"

    enable_dev_login: bool = False

    # Floor plan assets (TDD §14.3). Local disk in development; S3 replaces the store
    # behind app/services/storage.py without the callers changing.
    storage_dir: str = "var/storage"
    max_plan_upload_bytes: int = 25 * 1024 * 1024
    #: Longest edge a rasterized plan is allowed to have. Facilities teams upload
    #: architectural scans at absurd resolutions; the viewer draws them at phone width.
    plan_max_edge_px: int = 4000
    plan_pdf_render_width_px: int = 2400
    #: Plan URLs are signed rather than bearer-authenticated: <Image> tags in the mobile
    #: renderer cannot attach an Authorization header (TDD §11, "signed CDN url").
    plan_url_ttl_seconds: int = 3600

    log_level: str = "INFO"
    sql_echo: bool = False

    cors_origins: list[str] = Field(default_factory=lambda: ["http://localhost:3000"])

    def assert_safe(self) -> None:
        """Fail fast rather than ship a dev backdoor. Called at startup."""
        if self.environment != "development":
            if self.enable_dev_login:
                raise RuntimeError("ENABLE_DEV_LOGIN must be false outside development")
            if "change-me" in self.jwt_signing_key or len(self.jwt_signing_key) < 32:
                raise RuntimeError("JWT_SIGNING_KEY must be a real secret outside development")


@lru_cache
def get_settings() -> Settings:
    return Settings()
