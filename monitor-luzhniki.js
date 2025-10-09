- run: node monitor-luzhniki.js
  env:
    TG_BOT_TOKEN: ${{ secrets.TG_BOT_TOKEN }}
    TG_CHAT_ID: ${{ secrets.TG_CHAT_ID }}
    PROXY_LIST: ${{ secrets.PROXY_LIST }}
    DUMP_ALL: '1'
