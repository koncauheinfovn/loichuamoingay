# Lời Chúa + Lịch Phụng Vụ Tự Động

Bộ này không cố định năm. Website chỉ cần gọi một API Worker duy nhất, ví dụ:

```txt
https://TEN-WORKER-CUA-BAN.workers.dev/api/date/2026-06-01
https://TEN-WORKER-CUA-BAN.workers.dev/api/month?y=2026&m=6
https://TEN-WORKER-CUA-BAN.workers.dev/api/today
```

Worker sẽ ưu tiên đọc JSON trên GitHub Pages. Nếu chưa có JSON của năm/tháng đó, Worker tự đọc trực tiếp từ Augustino theo `y` và `m`.

## Cài đặt GitHub

```bash
npm install
DATA_YEARS=auto npm run build:data
```

`DATA_YEARS` hỗ trợ:

```txt
auto
current
current+5
current-1+5
2026-2030
2026,2027,2028
```

## Cloudflare Worker

Dán toàn bộ `worker/cloudflare-worker-dynamic.js` vào Cloudflare Worker.

## Blogger

Dán `blogger-widget-dynamic.html` vào HTML/JavaScript widget.

Trong widget, sửa một lần:

```js
API_BASE: 'https://TEN-WORKER-CUA-BAN.workers.dev'
```

Từ đó website dùng lâu dài, không cần sửa năm.
