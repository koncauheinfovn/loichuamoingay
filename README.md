# Lời Chúa Hằng Ngày + Lịch Phụng Vụ Việt Nam

Bản cuối: không cố định năm, không hiển thị Suy niệm, không tự load ảnh ngoài.

## Nguồn

- Lịch phụng vụ: `https://augustino.net/lich-phung-vu?y=YYYY&m=MM`
- Lời Chúa: `https://www.vaticannews.va/vi/loi-chua-hang-ngay/YYYY/MM/DD.html`
- Worker/API: Cloudflare Worker của bạn
- JSON cache: GitHub Pages / GitHub Raw

## 1. Đưa code lên GitHub

```bash
cd ~/Downloads

rm -rf loichuamoingay
git clone https://github.com/koncauheinfovn/loichuamoingay.git
cd loichuamoingay

rsync -a --delete --exclude='.git' /home/its/Downloads/loichuamoingay-final-a-z/ ./

npm install
DATA_YEARS=auto FULL_READINGS=0 npm run build:data

git add -A
git commit -m "Final dynamic Catholic daily readings system"
git push origin main
```

Nếu muốn JSON cũng chứa đầy đủ bản văn Lời Chúa thì chạy:

```bash
DATA_YEARS=2026 FULL_READINGS=1 npm run build:data
```

## 2. Cloudflare Worker

Dán toàn bộ file:

```txt
worker/cloudflare-worker.js
```

vào Cloudflare Worker `loichuamoingay`, bấm **Deploy**.

Test:

```txt
https://loichuamoingay.gioankminhcssr.workers.dev/
https://loichuamoingay.gioankminhcssr.workers.dev/api/date/2026-06-01
```

Ở `/api/date/2026-06-01` phải có:

```json
"reading1": { "reference": "2 Pr 1,2-7", "text": "..." },
"psalm": { "reference": "Tv 90...", "response": "..." },
"gospel_acclamation": "...",
"gospel": { "reference": "Mc 12,1-12", "text": "..." }
```

## 3. Blogger

Xóa widget cũ, dán toàn bộ file:

```txt
blogger-widget-final.txt
```

vào tiện ích HTML/JavaScript của Blogger.

Trong file này đã đặt:

```js
API_BASE: "https://loichuamoingay.gioankminhcssr.workers.dev"
```

## 4. Các endpoint

```txt
/api/today
/api/date/YYYY-MM-DD
/api/month?y=YYYY&m=MM
/api/year/YYYY
```

Ví dụ:

```txt
/api/date/2026-06-01
/api/month?y=2030&m=12
/api/year/2029
```
