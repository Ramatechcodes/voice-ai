RAMATECH HOME AI - PHASE 6B
Remote Internet Control + Voice

RENDER SETTINGS
Build Command: npm install
Start Command: npm start

ENVIRONMENT VARIABLES
DEVICE_TOKEN = choose a long secret, e.g. RMT_DEVICE_6B_xxxxxxxxx
ACCESS_CODE = choose the code you will enter on your phone
DEVICE_ID = RAMATECH_HOME_01

After deployment, open the Render HTTPS URL on your iPhone from anywhere.
Tap CONNECT TO RAMATECH CLOUD and enter ACCESS_CODE.

ESP32 SETTINGS
HOME_WIFI = your home router WiFi name
HOME_WIFI_PASSWORD = your home router password
CLOUD_HOST = your Render hostname only, e.g. ramatech-home-ai.onrender.com
DEVICE_TOKEN = exactly the same value as Render DEVICE_TOKEN
DEVICE_ID = exactly the same value as Render DEVICE_ID

ARDUINO LIBRARIES
1. WebSockets by Markus Sattler / Links2004
2. ArduinoJson

IMPORTANT
The ESP32 code uses WSS (secure WebSocket). Render supports public WebSocket connections and TLS; use wss:// for the public connection.
The browser voice recognition still depends on the iPhone/browser Web Speech API. The cloud remote-control path itself does not depend on voice recognition.


PHASE 7 UPGRADE NOTES
- Languages: English, Arabic and Yoruba (screen, voice commands and spoken replies).
- Voice settings: gender, accent, device voice, speed and pitch are saved on each device.
- The same index.html is also embedded in the ESP32 sketch (see tools/build_esp32_page.py).
- server.js now has a /status route and no longer serves server.js, package.json or .env.
