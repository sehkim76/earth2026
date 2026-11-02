"""동 그래프 DB 베이크: public/walkable/graph/*.json → route_dong_graphs (gzip 압축)."""
import gzip
import json
import os
import time

import pymysql

GRAPH_DIR = os.path.join(os.path.dirname(__file__), "..", "public", "walkable", "graph")

conn = pymysql.connect(
    host="armission-db1.xrart.co.kr",
    user="root",
    password="qntkseo,3",
    database="ArMissionAppDb",
    charset="utf8mb4",
    binary_prefix=True,
)
files = sorted(f for f in os.listdir(GRAPH_DIR) if f.endswith(".json"))
print("files:", len(files), flush=True)
now = int(time.time() * 1000)
done = 0
with conn.cursor() as cur:
    for f in files:
        dong = f[:-5]
        with open(os.path.join(GRAPH_DIR, f), "rb") as fp:
            gz = gzip.compress(fp.read(), compresslevel=6)
        cur.execute(
            "INSERT INTO route_dong_graphs (dong, data, updated_at) VALUES (%s, %s, %s) "
            "ON DUPLICATE KEY UPDATE data = VALUES(data), updated_at = VALUES(updated_at)",
            (dong, gz, now),
        )
        done += 1
        if done % 500 == 0:
            conn.commit()
            print(f"done {done}/{len(files)}", flush=True)
    conn.commit()
    cur.execute("SELECT COUNT(*), SUM(LENGTH(data)) FROM route_dong_graphs")
    c, b = cur.fetchone()
    print("rows:", c, "bytes MB:", round(b / 1048576, 1), flush=True)
conn.close()
