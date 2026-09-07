"""Create Vervfy persistent PostgreSQL tables."""
from alembic import op
import sqlalchemy as sa

revision = "0001_postgres_persistence"
down_revision = None
branch_labels = None
depends_on = None

def upgrade() -> None:
    op.create_table("users", sa.Column("id", sa.String(32), primary_key=True), sa.Column("username", sa.String(32), nullable=False, unique=True), sa.Column("username_key", sa.String(32), nullable=False, unique=True), sa.Column("email", sa.String(320), unique=True), sa.Column("password_hash", sa.String(128), nullable=False), sa.Column("created_at", sa.Float(), nullable=False))
    op.create_index("ix_users_username_key", "users", ["username_key"])
    op.create_table("tracks", sa.Column("id", sa.String(64), primary_key=True), sa.Column("user_id", sa.String(32), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True), sa.Column("filename", sa.String(512), nullable=False), sa.Column("title", sa.String(512), nullable=False), sa.Column("artist", sa.String(512), nullable=False), sa.Column("album", sa.String(512), nullable=False), sa.Column("duration", sa.Float(), nullable=False), sa.Column("has_cover", sa.Boolean(), nullable=False), sa.Column("custom_lyrics", sa.Text()), sa.Column("audio_data", sa.LargeBinary(), nullable=False), sa.Column("cover_data", sa.LargeBinary(), nullable=False))
    op.create_table("favorites", sa.Column("user_id", sa.String(32), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True), sa.Column("track_id", sa.String(64), primary_key=True))
    op.create_table("playlists", sa.Column("id", sa.String(64), primary_key=True), sa.Column("user_id", sa.String(32), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False), sa.Column("name", sa.String(200), nullable=False))
    op.create_index("ix_playlists_user_id", "playlists", ["user_id"])
    op.create_table("playlist_tracks", sa.Column("playlist_id", sa.String(64), sa.ForeignKey("playlists.id", ondelete="CASCADE"), primary_key=True), sa.Column("track_id", sa.String(64), primary_key=True), sa.Column("position", sa.Integer(), nullable=False))

def downgrade() -> None:
    op.drop_table("playlist_tracks"); op.drop_index("ix_playlists_user_id", table_name="playlists"); op.drop_table("playlists"); op.drop_table("favorites"); op.drop_table("tracks"); op.drop_index("ix_users_username_key", table_name="users"); op.drop_table("users")
