#!/bin/bash

URL="http://localhost:5000/blogs"
DURATION=10
REQUESTS_PER_SEC=1000
LOG_FILE="read_load_test_results.log"

echo "Starting load test (logging to $LOG_FILE)..."
echo "Timestamp,Elapsed(ms)" > "$LOG_FILE"

for second in $(seq 1 $DURATION); do
  for i in $(seq 1 $REQUESTS_PER_SEC); do
    {
      start=$(date +%s%3N)
      curl -s -o /dev/null -w "%{time_total}\n" "$URL" | awk -v s="$start" '{print s "," ($1*1000)}' >> "$LOG_FILE"
    } &
  done
done

wait
echo "Done. Results saved in $LOG_FILE"
