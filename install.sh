#!/bin/bash

# AmneziaWG Easy Hub v2.0 - Universal Installation Script 🚀
# Это умный установщик, который подготовит ваш сервер и развернет ноду.

set -e

# Цвета для вывода
GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${BLUE}${BOLD}============================================================${NC}"
echo -e "${BLUE}${BOLD}🚀 AMNEZIAWG UNIVERSAL INSTALLER v2.0${NC}"
echo -e "${BLUE}${BOLD}============================================================${NC}"

# 1. Проверка прав root
if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}Ошибка: Пожалуйста, запустите скрипт от имени root (через sudo).${NC}"
  exit 1
fi

# 2. Определение менеджера пакетов и установка базовых зависимостей
echo -e "\n${BLUE}[1/5] Проверка системных зависимостей...${NC}"
if command -v apt-get >/dev/null; then
    apt-get update -y && apt-get install -y curl jq iptables
elif command -v yum >/dev/null; then
    yum install -y curl jq iptables
else
    echo -e "${RED}Предупреждение: Не удалось определить менеджер пакетов. Убедитесь, что curl и jq установлены.${NC}"
fi

# 3. Проверка и установка Docker
echo -e "\n${BLUE}[2/5] Проверка Docker...${NC}"
if ! command -v docker >/dev/null; then
    echo -e "${BLUE}Docker не найден. Начинаю установку...${NC}"
    curl -fsSL https://get.docker.com -o get-docker.sh
    sh get-docker.sh
    systemctl enable docker
    systemctl start docker
    echo -e "${GREEN}Docker успешно установлен!${NC}"
else
    echo -e "${GREEN}Docker уже установлен.${NC}"
fi

# Подготовка системы (Ядро и Маршрутизация)
echo -e "\n${BLUE}[3/5] Подготовка ядра системы...${NC}"
modprobe wireguard || echo -e "${RED}Предупреждение: Не удалось загрузить модуль wireguard. Убедитесь, что он установлен на хосте.${NC}"
modprobe tun || echo -e "${RED}Предупреждение: Не удалось загрузить модуль tun.${NC}"

# Включение форвардинга пакетов (критично для доступа в интернет)
sysctl -w net.ipv4.ip_forward=1 > /dev/null
sysctl -w net.ipv4.conf.all.src_valid_mark=1 > /dev/null
echo "net.ipv4.ip_forward=1" > /etc/sysctl.d/99-amnezia-forwarding.conf
echo "net.ipv4.conf.all.src_valid_mark=1" >> /etc/sysctl.d/99-amnezia-forwarding.conf
sysctl -p /etc/sysctl.d/99-amnezia-forwarding.conf > /dev/null

# 5. Настройка
echo -e "\n${BLUE}[4/5] Настройка...${NC}"

# Попытка определить внешний IP
AUTO_IP=$(curl -s --connect-timeout 2 ifconfig.me || curl -s --connect-timeout 2 icanhazip.com || echo "0.0.0.0")

echo -e "Нажмите ENTER, чтобы использовать значения по умолчанию."

read -p "Имя этого сервера (напр. Sofia-Hub): " NODE_NAME < /dev/tty
NODE_NAME=${NODE_NAME:-"My Server"}

read -p "Публичный IP сервера (по умолчанию $AUTO_IP): " WG_HOST < /dev/tty
WG_HOST=${WG_HOST:-$AUTO_IP}

read -p "Пароль администратора (по умолчанию 'admin'): " ADMIN_PWD < /dev/tty
ADMIN_PWD=${ADMIN_PWD:-"admin"}

read -p "Порт Web UI (по умолчанию 51821): " GUI_PORT < /dev/tty
GUI_PORT=${GUI_PORT:-51821}

read -p "Порт WireGuard UDP (по умолчанию 51820): " WG_PORT_VAL < /dev/tty
WG_PORT_VAL=${WG_PORT_VAL:-51820}

read -p "Порт управления / Agent (по умолчанию 161): " AGNT_PORT < /dev/tty
AGNT_PORT=${AGNT_PORT:-161}

# 6. Развертывание контейнера
echo -e "\n${BLUE}[5/5] Развертывание AmneziaWG Node...${NC}"

# Очистка и принудительное обновление
echo -e "${BLUE}Очистка кэша и скачивание свежего образа...${NC}"
docker system prune -f >/dev/null
docker pull ghcr.io/sky-night-net/amneziawg-v2:latest

# Подготовка директории для данных
mkdir -p ~/.amnezia-wg

# Удаление старого контейнера если он есть
if [ "$(docker ps -aq -f name=amnezia-node)" ]; then
    echo -e "${BLUE}Обнаружен старый контейнер. Обновляю...${NC}"
    docker stop amnezia-node
    docker rm amnezia-node
fi

# Запуск новой версии (Контейнер использует eth0 для интернета внутри bridge сети)
docker run -d \
  --name amnezia-node \
  --restart unless-stopped \
  -v ~/.amnezia-wg:/etc/amnezia-wg \
  -v /etc/localtime:/etc/localtime:ro \
  -v /etc/timezone:/etc/timezone:ro \
  -e WG_PORT=$WG_PORT_VAL \
  -e AGENT_PORT=$AGNT_PORT \
  -e WG_DEVICE=eth0 \
  -e NODE_NAME="$NODE_NAME" \
  -e WG_HOST="$WG_HOST" \
  -e ADMIN_PASSWORD="$ADMIN_PWD" \
  -p $WG_PORT_VAL:$WG_PORT_VAL/udp \
  -p $GUI_PORT:51821/tcp \
  -p $AGNT_PORT:$AGNT_PORT/tcp \
  --privileged \
  ghcr.io/sky-night-net/amneziawg-v2:latest

echo -e "${GREEN}Контейнер успешно запущен!${NC}"

# 6. Получение токена и финализация
echo -e "\n${BLUE}[5/5] Генерация Node Identity...${NC}"
echo -e "Подождите несколько секунд для генерации токена..."
sleep 5

# Чтение токена напрямую из файла внутри контейнера
TOKEN=$(docker exec amnezia-node cat /etc/amnezia-wg/agent_token.json | jq -r .token)

echo -e "\n${GREEN}${BOLD}============================================================${NC}"
echo -e "${GREEN}${BOLD}🎉 УСТАНОВКА ЗАВЕРШЕНА!${NC}"
echo -e "${GREEN}${BOLD}============================================================${NC}"
echo -e "${BOLD}🌍 Web UI Dashboard:${NC} http://$(hostname -I | awk '{print $1}'):${GUI_PORT}"
echo -e "${BOLD}🔑 SECRET AGENT TOKEN:${NC} ${TOKEN}"
echo -e "${BOLD}📡 Management Port:${NC} ${AGNT_PORT} (TCP)"
echo -e "${GREEN}${BOLD}============================================================${NC}"
echo -e "\nИспользуйте этот TOKEN в вашей главной панели для добавления этого сервера."
echo -e "Для просмотра логов: ${BLUE}docker logs -f amnezia-node${NC}\n"
