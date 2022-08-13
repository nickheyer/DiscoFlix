for /f "delims=[] tokens=2" %%a in ('ping -4 -n 1 %ComputerName% ^| findstr [') do set NetworkIP=%%a
start "" http:%NetworkIP%:5000
waitress-serve --host %NetworkIP% --port 5000 app:app