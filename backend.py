"""
Lightweight backend for Render — serves Firebase config from environment variables.
No ML dependencies. Requires only: fastapi uvicorn
"""

import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://hammadrehmanawan.github.io"],
    allow_methods=["GET"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/firebase-config")
def firebase_config():
    return JSONResponse({
        "apiKey":            os.environ.get("FIREBASE_API_KEY", ""),
        "authDomain":        os.environ.get("FIREBASE_AUTH_DOMAIN", ""),
        "projectId":         os.environ.get("FIREBASE_PROJECT_ID", ""),
        "storageBucket":     os.environ.get("FIREBASE_STORAGE_BUCKET", ""),
        "messagingSenderId": os.environ.get("FIREBASE_MESSAGING_SENDER_ID", ""),
        "appId":             os.environ.get("FIREBASE_APP_ID", ""),
        "measurementId":     os.environ.get("FIREBASE_MEASUREMENT_ID", ""),
    })


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)
