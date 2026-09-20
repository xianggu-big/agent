@echo off
cd /d %~dp0
echo ============================================
echo   QuestionForge 智能制题平台（多用户版）
echo   浏览器访问 http://localhost:8540
echo   首次使用请先注册（第一个注册者即管理员）
echo   关闭本窗口即停止服务
echo ============================================
echo.
echo 检查 MySQL 连接...
node -e "require('./lib/db').init().then(()=>{console.log('MySQL 连接正常');process.exit(0)}).catch(e=>{console.error('MySQL 连接失败:',e.message);console.error('请确认 MySQL 已启动且 root 密码为 123456');process.exit(1)})"
if errorlevel 1 (pause & exit /b 1)
start "" http://localhost:8540
node server.js
