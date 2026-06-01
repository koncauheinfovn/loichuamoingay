# Final fix v2

Sửa lỗi:
- Worker decode `&ecirc;`, `&agrave;`, v.v. trước khi parse Vatican News.
- Worker ghi đè readings từ Vatican vào JSON trả về, không merge với JSON rỗng cũ.
- Có Bài đọc I, Bài đọc II nếu có, Đáp ca, Tung hô Tin Mừng, Tin Mừng.
- Không có Suy niệm.
- Widget có nút -/+ tăng giảm font.
- Không load ảnh ngoài.

## Cloudflare Worker
Dán `cloudflare-worker-final-fix-v2.txt` vào Worker rồi Deploy.

Test:
https://loichuamoingay.gioankminhcssr.workers.dev/api/date/2026-06-01

## Blogger
Dán `blogger-widget-final-fix-v2.txt` vào tiện ích HTML/JavaScript.

## GitHub JSON
```bash
cd ~/Downloads/loichuamoingay
npm install
DATA_YEARS=2026 npm run build:data
git add -A
git commit -m "Fix full readings JSON and widget"
git push origin main
```
