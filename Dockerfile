FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt update && apt install -y \
    build-essential cmake git mysql-server libmysqlclient-dev \
    libssl-dev libreadline-dev libbz2-dev libboost-all-dev \
    libncurses-dev libace-dev libtbb-dev nodejs procps

RUN git clone https://github.com/mod-playerbots/azerothcore-wotlk.git /acore
WORKDIR /acore

RUN git clone https://github.com/mod-playerbots/mod-playerbots.git modules/mod-playerbots

RUN mkdir build && cd build && \
    cmake .. -DCMAKE_INSTALL_PREFIX=/opt/acore -DTOOLS_BUILD=all && \
    make -j$(nproc) && make install

RUN mkdir -p /opt/acore/data && \
    mysqld --initialize-insecure --datadir=/opt/acore/data

RUN mkdir -p /opt/acore/etc

COPY my.cnf /etc/mysql/my.cnf
COPY configs /opt/acore/etc
COPY dashboard /opt/dashboard
COPY start.sh /start.sh

RUN chmod +x /start.sh

EXPOSE 8085 3724 3310 8000

CMD ["/start.sh"]
