@echo off
REM Lanceur du Simulateur Budgetaire
cd /d "%~dp0"
echo Demarrage du Simulateur Budgetaire...
echo Ouvrez http://localhost:4173 dans votre navigateur.
node server.js
pause
