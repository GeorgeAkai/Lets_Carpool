import logging
import os

import azure.functions as func
import httpx

app = func.FunctionApp()


@app.timer_trigger(schedule="0 0 * * * *", arg_name="timer", run_on_startup=False)
def cron_expire(timer: func.TimerRequest) -> None:
    backend_url = os.environ["BACKEND_URL"].rstrip("/")
    cron_secret = os.environ["CRON_SECRET"]

    response = httpx.get(
        f"{backend_url}/cron/expire",
        headers={"Authorization": f"Bearer {cron_secret}"},
        timeout=30,
    )
    response.raise_for_status()
    logging.info("cron/expire responded %s: %s", response.status_code, response.text)
