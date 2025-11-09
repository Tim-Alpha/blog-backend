#!/bin/bash

API_URL="http://localhost:5000/blog"

echo "Starting 20 blog post insert test..."
for i in $(seq 1 20); do
  TITLE="Replication Test Blog #$i"
  BODY="This is blog post number $i created for Solana-like MySQL replication test at $(date '+%H:%M:%S')."

  curl -s -X POST "$API_URL" \
    -H "Content-Type: application/json" \
    -d "{\"title\":\"$TITLE\",\"body\":\"$BODY\"}" > /dev/null

  echo "Inserted Blog #$i"
done

echo "All 20 blogs inserted successfully!"
