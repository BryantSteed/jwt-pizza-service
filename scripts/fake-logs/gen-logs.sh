#!/usr/bin/env bash
for i in {1..100}; do
  (( RANDOM % 2 )) && level="warn" || level="info"

  curl -X POST \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $account_id:$api_key" \
    -d '{"streams": [{"stream": {"component":"jwt-pizza-service", "level": "'"$level"'", "type":"http-req"},"values": [["'"$(($(date +%s)*1000000000))"'","{\"name\":\"hacker\", \"email\":\"d@jwt.com\", \"password\":\"****\"}",{"user_id": "44","traceID": "9bc86924d069e9f8ccf09192763f1120"}]]}]}' \
    $endpoint_url

  echo "just sent some good log stuff"
  sleep 3
done