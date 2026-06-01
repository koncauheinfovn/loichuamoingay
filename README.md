# loichuamoingay

Hệ thống tự động tạo JSON Công giáo hằng ngày cho Blogger.

## Nguồn dữ liệu

- Lịch phụng vụ: `https://gcatholic.org/calendar/{year}/VN-H-vi`
- Lời Chúa hằng ngày: `https://www.vaticannews.va/vi/loi-chua-hang-ngay/{year}/{month}/{day}.html`
- Ảnh thánh: Wikipedia API, Wikimedia Commons API, Vatican News, Catholic Saints

## Cấu trúc

```txt
project/
├── data/
├── scripts/
│   ├── crawler.js
│   ├── image-fetcher.js
│   └── generate-json.js
├── worker/
│   ├── cloudflare-worker.js
│   └── wrangler.toml.example
├── .github/workflows/
│   └── github-workflow.yml
├── package.json
└── README.md
```

## Cài đặt

```bash
npm install
```

## Chạy mặc định 2026-2030

Mặc định script lấy khoảng năm `2026-2030`.

```bash
npm run build:data
```

Tương đương:

```bash
DATA_YEARS=2026-2030 npm run build:data
```

## Chạy một khoảng năm cụ thể

```bash
DATA_YEARS=2026-2030 npm run build:data
```

## Backfill đầy đủ toàn bộ ngày trong các năm tìm thấy

```bash
DATA_YEARS=2026-2030 FULL_BACKFILL=true npm run build:data
```

## Giới hạn năm khi tự dò

```bash
DATA_YEARS=2026-2030 npm run build:data
```

## File xuất ra

```txt
data/today.json
data/week.json
data/month.json
data/years.json
data/year-2026.json
data/year-2027.json
data/year-2028.json
data/year-2029.json
data/year-2030.json
```

## GitHub Actions

Workflow chạy mỗi ngày lúc `17:05 UTC`, tương đương `00:05 UTC+7`.

Mặc định:

```txt
DATA_YEARS=2026-2030
FULL_BACKFILL=false
```

Khi cần crawl toàn bộ dữ liệu đã có, vào GitHub Actions → Run workflow:

```txt
data_years = 2026-2030
full_backfill = true
gcatholic_year_start = 2026
gcatholic_year_end = 2030
```

## Cloudflare Worker endpoints

```txt
/api/today
/api/week
/api/month
/api/years
/api/year/2026
/api/date/2026-06-01
```

## Deploy Worker

```bash
cd worker
cp wrangler.toml.example wrangler.toml
npx wrangler deploy
```
