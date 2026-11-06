"""Small sampler executed only in the disposable app container."""
import json
import os
import time
from pathlib import Path
import pymysql
import redis
from sqlalchemy.engine.url import make_url

assert os.environ.get("QUEST_LOADTEST") == "isolated-event-capacity-test"
url=make_url(os.environ["DATABASE_URL"])
assert url.database == "ctfd_loadtest_test"

def read(path):
    try:
        return Path(path).read_text().strip()
    except OSError:
        return None

out={'timestamp':time.time(),'cgroup':{n:read('/sys/fs/cgroup/'+n) for n in [
    'cpu.stat','cpu.max','cpu.weight','memory.current','memory.peak','memory.events','memory.stat','memory.max','io.stat'
]}}
try:
    conn=pymysql.connect(host=url.host,user=url.username,password=url.password,database=url.database,connect_timeout=2,read_timeout=2)
    with conn.cursor() as c:
        c.execute("SHOW GLOBAL STATUS WHERE Variable_name IN ('Questions','Queries','Threads_connected','Threads_running','Max_used_connections','Slow_queries','Innodb_row_lock_waits','Innodb_row_lock_time','Innodb_buffer_pool_reads','Innodb_buffer_pool_read_requests','Bytes_received','Bytes_sent','Aborted_connects')")
        out['database']={k:int(v) for k,v in c.fetchall()}
    conn.close()
except Exception as e:
    out['database_error']=type(e).__name__
try:
    info=redis.Redis.from_url(os.environ['REDIS_URL'],socket_connect_timeout=2,socket_timeout=2).info()
    out['redis']={k:info[k] for k in ['used_memory','used_memory_peak','connected_clients','total_commands_processed','instantaneous_ops_per_sec','evicted_keys','keyspace_hits','keyspace_misses']}
except Exception as e:
    out['redis_error']=type(e).__name__
out['sampler_duration_s']=time.time()-out['timestamp']
print(json.dumps(out))
