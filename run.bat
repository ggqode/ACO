@echo off
setlocal enabledelayedexpansion

echo ====================================================
echo      ACO - CART OPTIMIZER - JEDNO KLIKNIECIE
echo ====================================================

set "PYTHON_CMD="

:: Sprawdzenie czy python jest w PATH
python --version >nul 2>&1
if %errorlevel% == 0 (
    set "PYTHON_CMD=python"
)

:: Jeśli nie ma python, sprawdź py
if "%PYTHON_CMD%"=="" (
    py --version >nul 2>&1
    if !errorlevel! == 0 (
        set "PYTHON_CMD=py"
    )
)

:: Jeśli nadal brak, instalujemy przez winget
if "%PYTHON_CMD%"=="" (
    echo [Setup] Nie znaleziono interpretera Python w systemie.
    echo [Setup] Proba automatycznej instalacji za pomocą winget...
    
    where winget >nul 2>&1
    if !errorlevel! NEQ 0 (
        echo [Error] Nie znaleziono narzedzia winget ani Pythona.
        goto :manual_python
    )
    
    echo [Setup] Znaleziono winget. Instaluje Python 3.11 - moze to chwile potrwac...
    winget install --id Python.Python.3.11 --silent --accept-source-agreements --accept-package-agreements
    
    rem Szukamy pliku exe w domyślnych ścieżkach instalacji winget
    if exist "%USERPROFILE%\AppData\Local\Programs\Python\Python311\python.exe" (
        set "PYTHON_CMD=%USERPROFILE%\AppData\Local\Programs\Python\Python311\python.exe"
    ) else if exist "C:\Program Files\Python311\python.exe" (
        set "PYTHON_CMD=C:\Program Files\Python311\python.exe"
    ) else if exist "%USERPROFILE%\AppData\Local\Programs\Python\Python312\python.exe" (
        set "PYTHON_CMD=%USERPROFILE%\AppData\Local\Programs\Python\Python312\python.exe"
    ) else if exist "C:\Program Files\Python312\python.exe" (
        set "PYTHON_CMD=C:\Program Files\Python312\python.exe"
    ) else (
        echo [Warning] Python zainstalowany, ale nie można znaleźć ścieżki python.exe.
        set "PYTHON_CMD=python"
    )
)

echo [Setup] Uzywam interpretera: !PYTHON_CMD!

:: Tworzenie wirtualnego środowiska venv
if not exist venv (
    echo [Setup] Tworze wirtualne środowisko venv...
    "!PYTHON_CMD!" -m venv venv
)

echo [Setup] Instaluje i aktualizuje zaleznosci w venv...
call .\venv\Scripts\activate.bat
python -m pip install --upgrade pip
python -m pip install -r requirements.txt

echo [Setup] Instaluje przegladarki dla Playwright...
playwright install chromium

echo ====================================================
echo             URUCHAMIANIE BOTA ALLEGRO
echo ====================================================
python main.py
pause
exit /b

:manual_python
echo [Error] Nie udalo sie automatycznie zainstalowac jezyka Python.
echo [Setup] Zainstaluj Python 3.11 lub nowszy reecznie ze strony:
echo         https://www.python.org/downloads/
echo         Upewnij się, że zaznaczysz opcje Add Python to PATH podczas instalacji!
pause
exit /b
