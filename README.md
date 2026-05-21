# loichuamoingay Cloudflare Worker

Repo này là Cloudflare Worker lấy Lời Chúa tiếng Việt từ Vatican News.

## File bắt buộc

- `worker-vatican-news-tieng-viet.js`
- `wrangler.toml`
- `package.json`

## Test sau khi deploy

Mở:

`https://<worker-cua-ban>.workers.dev?date=2026-05-21`

Nếu đúng, API trả JSON có `"ok": true`.
