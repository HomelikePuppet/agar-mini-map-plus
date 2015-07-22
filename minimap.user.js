// ==UserScript==
// @name         agar-mini-map-plus
// @namespace    http://gibt-es-nicht.com
// @version      0.01
// @description  This script will show a mini map and your location on agar.io
// @author       dimotsai | edited by piJoe
// @license      MIT
// @match        http://agar.io/*
// @require      http://cdn.jsdelivr.net/msgpack/1.05/msgpack.js
// @grant        none
// @downloadURL  
// @run-at       document-body
// ==/UserScript==

window.msgpack = this.msgpack;

(function() {
    var _WebSocket = window._WebSocket = window.WebSocket;
    var $ = window.jQuery;
    var msgpack = window.msgpack;
    var options = {
        enableMultiCells: true,
        enablePosition: true,
        enableCross: true
    };
    //edit begin
    var agarSocket, toggleBot = false;
    var serverEvent;
    var lastSplit = 0;
    //edit end

    // game states
    var agar_server = null;
    var map_server = null;
    var player_name = [];
    var players = [];
    var id_players = [];
    var cells = [];
    var current_cell_ids = [];
    var start_x = -7000,
        start_y = -7000,
        end_x = 7000,
        end_y = 7000,
        length_x = 14000,
        length_y = 14000;
    var render_timer = null;

    //edit begin
    function agarSocketSend(data) {
        if (agarSocket) {
            var array = new Uint8Array(data);
            agarSocket.directSend(array.buffer);
        }
    }

    function agarSocketSendToSelf(data) {
        if (agarSocket) {
            var event = {};
            event.timeStamp = Date.now();

            var array = new Uint8Array(data);
            event.data = array.buffer;

            agarSocket.directOnMessage(event);
        }
    }

    function blobMoveTo(x,y, showLine) {
        var buffer = new ArrayBuffer(21);
        var packet = new DataView(buffer);
        var offset = 0;
        packet.setUint8(offset, 16);
        offset+=1;
        packet.setFloat64(offset, x, !0);
        offset+=8;
        packet.setFloat64(offset, y, !0);
        offset+=8;
        packet.setUint32(offset, 0);

        agarSocketSend(packet.buffer);
        //console.log('moving to ' + x + " / " + y);

        //send drawLine to self...
        if (showLine) {
            buffer = new ArrayBuffer(5);
            packet = new DataView(buffer);
            offset = 0;
            packet.setUint8(offset, 21);
            offset+=1;
            packet.setInt16(offset, x, !0);
            offset+=2;
            packet.setInt16(offset, y, !0);
            offset+=2;
            agarSocketSendToSelf(packet.buffer);
        }
    }

    function blobSplit() {
        if (lastSplit < Date.now() - 1000) {
            var buffer = new ArrayBuffer(1);
            var packet = new DataView(buffer);
            var offset = 0;
            packet.setUint8(offset, 17);

            agarSocketSend(packet.buffer);
            lastSplit = Date.now();
        }
    }
    //edit end

    function miniMapSendRawData(data) {
        if (map_server !== null && map_server.readyState === window._WebSocket.OPEN) {
            var array = new Uint8Array(data);
            map_server.send(array.buffer);
        }
    }

    function miniMapConnectToServer(address, onOpen, onClose) {
        try {
            var ws = new window._WebSocket(address);
        } catch (ex) {
            onClose();
            console.error(ex);
            return false;
        }
        ws.binaryType = "arraybuffer";

        ws.onopen = function() {
            onOpen();
            console.log(address + ' connected');
        }

        ws.onmessage = function(event) {
            var buffer = new Uint8Array(event.data);
            var packet = msgpack.unpack(buffer);
            switch(packet.type) {
                case 128:
                    for (var i=0; i < packet.data.addition.length; ++i) {
                        var cell = packet.data.addition[i];
                        if (! miniMapIsRegisteredToken(cell.id))
                        {
                            miniMapRegisterToken(
                                cell.id,
                                miniMapCreateToken(cell.id, cell.color)
                            );
                        }

                        var size_n = cell.size/length_x;
                        miniMapUpdateToken(cell.id, (cell.x - start_x)/length_x, (cell.y - start_y)/length_y, size_n);
                    }

                    for (var i=0; i < packet.data.deletion.length; ++i) {
                        var id = packet.data.deletion[i];
                        miniMapUnregisterToken(id);
                    }
                    break;
                case 129:
                    players = packet.data;
                    for (var p in players) {
                        var player = players[p];
                        var ids = player.ids;
                        for (var i in ids) {
                            id_players[ids[i]] = player.no;
                        }
                    }
                    mini_map_party.trigger('update-list');

                    break;
            }
        }

        ws.onerror = function() {
            onClose();
            console.error('failed to connect to map server');
        }

        ws.onclose = function() {
            onClose();
            map_server = null;
            console.log('map server disconnected');
        }

        map_server = ws;
    }

    //edit begin
    function compareSize(player1, player2, ratio) {
        if (player1 * player1 * ratio < player2 * player2) {
            return true;
        }
        return false;
    }

    function canSplit(player1, player2) {
        return compareSize(player1, player2, 2.30);
    }

    function isSplitTarget(blob, cell) {
        return canSplit(cell, blob);
    }

    function isRewardableTarget(blob, cell) { //wenn blob 9 mal größer als target, dann lohnt nicht
        return !compareSize(cell, blob, 8.0);
    }

    function isFood(blob, cell) {
        if (compareSize(cell, blob, 1.30) || (cell <= 11)) {
            return true;
        }
        return false;
    }

    function colorCodeByThreatLevel(us,them, ctx) {
        ctx.fillStyle = '#0000ff';
        var threatLevel = 0;

        if(isFood(them, us)) { //they eat us
            ctx.fillStyle = '#FF9800'; //orange
            threatLevel = 1;
        }
        if(isSplitTarget(them, us)) { //they split and eat us
            ctx.fillStyle = '#880000'; //red
            threatLevel = 2;
        }
        if(isFood(us, them)) { //we eat them
            ctx.fillStyle = '#ffff00'; //yellow
            threatLevel = -1;
        }
        if(isSplitTarget(us, them)) { //we split and eat them
            ctx.fillStyle = '#008800'; //dunkelgrün
            threatLevel = -2;
        }

        return threatLevel;
    }

    function calculateDistance(pos1, pos2) {
        return Math.abs( (pos1.x - pos2.x)*(pos1.x - pos2.x) ) + Math.abs( (pos1.y - pos2.y)*(pos1.y - pos2.y) );
    }

    function getEnemyLocations() {
        var enemies = [];
        for(var id in cells) {
            var cell = cells[id];

            if (current_cell_ids.indexOf(cell.id) > -1) {
                continue;
            }

            if (cell.destroyed == true) {
                continue;
            }

            var x = cell.nx;
            var y = cell.ny;
            var size = cell.nSize;

            if (cell.isVirus && size < ownSizeSmallest) { //bei virus muss size KLEINER sein als eigener blob
                enemies.push({x: x, y: y, cell: cell, threatLevel: 1});
            }
            if (isSplitTarget(size, ownSizeSmallest)) {
                enemies.push({x: x, y: y, cell: cell, threatLevel: 2});
            }
            else if (isFood(size, ownSizeSmallest)) {
                enemies.push({x: x, y: y, cell: cell, threatLevel: 1});
            }
        }
        return enemies;
    }

    function getFoodLocations() {
        var foods = [];
        for(var id in cells) {
            var cell = cells[id];

            if (current_cell_ids.indexOf(cell.id) > -1) {
                continue;
            }

            if (cell.destroyed == true || cell.isVirus == true) {
                continue;
            }

            var x = cell.nx;
            var y = cell.ny;
            var size = cell.nSize;

            if ((cell.nSize > 100) && isSplitTarget(ownSizeSmallest, size) && isRewardableTarget(ownSizeSmallest, size)) {
                foods.push({ x: x, y: y, cell: cell, split: true });
            }
            else if (isFood(ownSizeSmallest, size)) {
                foods.push({ x: x, y: y, cell: cell });
            }
        }
        return foods;
    }

    function isFoodInEnemyRange(food, enemy) {
        var dist = Math.abs( (food.x - enemy.x)*(food.x - enemy.x) ) + Math.abs( (food.y - enemy.y)*(food.y - enemy.y) );
        var dangerDistance = calcEnemyDangerDistanceWithAdd(enemy, ownSizeSmallest);
        if (dist < dangerDistance) {
            return true;
        }
        return false;
    }

    function getSafeFoods() {
        var foods = getFoodLocations();
        var enemies = getEnemyLocations();

        var safeFoods = [];

        if (enemies.length == 0) {
            return foods;
        }
        for(var i in foods) {
            var food = foods[i];

            for (var j in enemies) {
                var enemy = enemies[j];
                if (!isFoodInEnemyRange(food,enemy)) {
                    safeFoods.push(food);
                }
            }
        }

        return safeFoods;
    }

    function getNearestSafeFood() {
        var foods = getSafeFoods();

        var nearest = false;
        var nearestDist = 999999999;
        for(var i in foods) {
            var food = foods[i];
            var dist = Math.abs((food.x - ownX)*(food.x - ownX)) + Math.abs((food.y - ownY)*(food.y - ownY));
            if (dist < nearestDist) {
                nearestDist = dist;
                nearest = food;
            }
        }
        return nearest;
    }

    function getMostRewardingSafeFood() {
        var foods = getSafeFoods();

        var best = false;
        var bestValue = -999999999;
        for(var i in foods) {
            var food = foods[i];
            var dist = Math.abs((food.x - ownX)*(food.x - ownX)) + Math.abs((food.y - ownY)*(food.y - ownY));
            var sizeFactor = food.cell.nSize*1.5;
            var distFactor = 1-(dist*0.05);
            //todo: add distToEnemyFactor wo je größer desto besser ist. | *0.1 vllt?
            var value = sizeFactor + distFactor;
            if (value > bestValue) {
                best = food;
                bestValue = value;
            }
        }
        return best;
    }

    function getNearestFood() {
        var foods = getFoodLocations();

        var nearest = false;
        var nearestDist = 999999999;
        for(var i in foods) {
            var food = foods[i];
            var dist = Math.abs((food.x - ownX)*(food.x - ownX)) + Math.abs((food.y - ownY)*(food.y - ownY));
            if (dist < nearestDist) {
                nearestDist = dist;
                nearest = food;
            }
        }
        return nearest;
    }

    /*
    function calcEnemyDangerDistance(enemy) {
        var dangerDistance = Math.pow(enemy.cell.nSize + 200, 2);
        if (enemy.threatLevel == 2) {
            dangerDistance = Math.pow(enemy.cell.nSize + 800, 2);
        }
        if (enemy.cell.isVirus) {
            dangerDistance = Math.pow(enemy.cell.nSize + 100, 2);
        }
        var shiftDistance = Math.pow(ownSizeSmallest, 2);
        return dangerDistance + shiftDistance;
    }*/
    function calcEnemyDangerDistance(enemy) {
        return calcEnemyDangerDistanceWithAdd(enemy,0);
    }
    function calcEnemyDangerDistanceWithAdd(enemy, add) {
        var dangerDistance = enemy.cell.nSize + 150;
        if (enemy.threatLevel == 2) {
            /*if (isRewardableTarget(ownSizeSmallest, enemy.cell.nSize)) {
                dangerDistance = enemy.cell.nSize + 700;
            } else {
                dangerDistance = enemy.cell.nSize + 200;
            }*/
            dangerDistance = enemy.cell.nSize + 700;
        }
        if (enemy.cell.isVirus) {
            dangerDistance = enemy.cell.nSize + 50;
        }
        var shiftDistance = ownSizeSmallest;
        dangerDistance += shiftDistance + add;
        return dangerDistance*dangerDistance;
    }

    function getNearestEnemy(enemies) {
        //var enemies = getEnemyLocations();

        var nearest = false;
        var nearestDist = 999999999;
        for(var i in enemies) {
            var enemy = enemies[i];
            var dist = Math.abs((enemy.x - ownX)*(enemy.x - ownX)) + Math.abs((enemy.y - ownY)*(enemy.y - ownY));

            var dangerDistance = calcEnemyDangerDistance(enemy);
            if (dist < nearestDist && dist < dangerDistance) {
                nearestDist = dist;
                nearest = enemy;
            }
        }
        return nearest;
    }

    function calculateNextPosition(enemies) {
        //var enemies = getEnemyLocations();

        var moveStepSize = ownSizeSmallest;
        var angleStepSize = 0.2;

        var minThreat = 999999999;
        var finalPos = null;
        for(var angle = 0; angle < 2*Math.PI; angle+=angleStepSize) {
            var moveX = moveStepSize * Math.cos(angle);
            var moveY = moveStepSize * Math.sin(angle);

            var newPos = {x: ownX+moveX, y: ownY+moveY};

            var threat = calculateThreatForPosition(newPos, enemies);

            if (threat < minThreat) {
                minThreat = threat;
                finalPos = newPos;
            }
        }
        return finalPos;
    }

    function calculateThreatForPosition(pos, enemies) {
        var totalDist = 1;

        for(var i in enemies) {
            var enemy = enemies[i];
            var dist = calculateDistance(pos, enemy);

            totalDist *= dist;
        }

        return (-1)*totalDist; //distance negiert. es gilt: je größer die Distanz, desto weniger Gefahr.
    }
    //edit end

    function miniMapRender() {
        var canvas = window.mini_map;
        var ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        for (var id in window.mini_map_tokens) {
            var token = window.mini_map_tokens[id];
            var x = token.x * canvas.width;
            var y = token.y * canvas.height;
            var size = token.size * canvas.width;

            ctx.beginPath();
            ctx.arc(
                x,
                y,
                size,
                0,
                2 * Math.PI,
                false
            );
            ctx.closePath();

            //edit beginn
            //ctx.fillStyle = token.color;
            var us = ownSizeSmallest;
            var them = token.oSize;
            //console.log(myMass + " / " + theirMass);
            if (current_cell_ids.indexOf(token.id) != -1) {
                ctx.fillStyle = '#ffffff';
            } else {
                var threatLevel = colorCodeByThreatLevel(us,them, ctx);

                if (threatLevel == 2) {
                    var myPos = {x: ownX, y: ownY};
                    var theirPos = {x: token.oPos.x, y: token.oPos.y};
                    var distance = calculateDistance(myPos, theirPos);
                    if (distance < (600+us)*(600+us)) {
                        ctx.fillStyle = '#ff0000';
                    }
                }
                if (threatLevel == -2) {
                    var myPos = {x: ownX, y: ownY};
                    var theirPos = {x: token.oPos.x, y: token.oPos.y};
                    var distance = calculateDistance(myPos, theirPos);
                    if (distance < (600+them)*(600+them)) {
                        ctx.fillStyle = '#00ff00';
                    }
                }
            }
            //edit end
            ctx.fill();

            if (options.enableCross && -1 != current_cell_ids.indexOf(token.id))
                miniMapDrawCross(token.x, token.y);

            if (id_players[id] !== undefined) {
                ctx.font = size * 2 + 'px Arial';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillStyle = 'white';
                ctx.fillText(id_players[id] + 1, x, y);
            }
        };

        //edit begin
        if (toggleBot) {
            var enemies = getEnemyLocations();
            var enemyLoc = getNearestEnemy(enemies);
            if (enemyLoc !== false) {
                console.log('enemy in range. avoid...');

                /* old system
                var offX = ownX - enemyLoc.x;
                var offY = ownY - enemyLoc.y;

                offX *= 0.1;
                offY *= 0.1;

                blobMoveTo(ownX + offX, ownY + offY, true); */

                var newPos = calculateNextPosition(enemies);
                blobMoveTo(newPos.x, newPos.y, true);
            } else {
                console.log('no enemy in range. continue feeding...');
                //var foodLoc = getNearestSafeFood();
                var foodLoc = getMostRewardingSafeFood();
                if (foodLoc !== false) {
                    blobMoveTo(foodLoc.x, foodLoc.y, true);


                    if (foodLoc.split) {
                        var distance = Math.abs((foodLoc.x - ownX)*(foodLoc.x - ownX)) + Math.abs((foodLoc.y - ownY)*(foodLoc.y - ownY));
                        if (distance < (600+foodLoc.cell.size)*(600+foodLoc.cell.size)) {
                            blobSplit();
                        }
                    }
                }
            }

            if (current_cell_ids.length == 0) {
                window.setTimeout(function() {
                    window.setNick('ruul');
                }, 1000);
            }
        }
        //edit end
    }

    function miniMapDrawCross(x, y) {
        var canvas = window.mini_map;
        var ctx = canvas.getContext('2d');
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(0, y * canvas.height);
        ctx.lineTo(canvas.width, y * canvas.height);
        ctx.moveTo(x * canvas.width, 0);
        ctx.lineTo(x * canvas.width, canvas.height);
        ctx.closePath();
        ctx.strokeStyle = '#FFFFFF';
        ctx.stroke();
    }

    function miniMapCreateToken(id, color) {
        var mini_map_token = {
            id: id,
            color: color,
            x: 0,
            y: 0,
            size: 0
        };
        return mini_map_token;
    }

    function miniMapRegisterToken(id, token) {
        if (window.mini_map_tokens[id] === undefined) {
            // window.mini_map.append(token);
            window.mini_map_tokens[id] = token;
        }
    }

    function miniMapUnregisterToken(id) {
        if (window.mini_map_tokens[id] !== undefined) {
            // window.mini_map_tokens[id].detach();
            delete window.mini_map_tokens[id];
        }
    }

    function miniMapIsRegisteredToken(id) {
        return window.mini_map_tokens[id] !== undefined;
    }

    //edit begin
    //function miniMapUpdateToken(id, x, y, size) {
    function miniMapUpdateToken(id, x, y, size, originalSize, oPos) {
    //edit end
        if (window.mini_map_tokens[id] !== undefined) {

            window.mini_map_tokens[id].x = x;
            window.mini_map_tokens[id].y = y;
            window.mini_map_tokens[id].size = size;
            //edit begin
            window.mini_map_tokens[id].oSize = originalSize;
            window.mini_map_tokens[id].oPos = oPos;
            //edit end

            return true;
        } else {
            return false;
        }
    }
    //edit end

    function miniMapUpdatePos(x, y) {
        window.mini_map_pos.text('x: ' + x.toFixed(0) + ', y: ' + y.toFixed(0));
    }

    function miniMapReset() {
        cells = [];
        window.mini_map_tokens = [];
    }

    function miniMapInit() {
        window.mini_map_tokens = [];

        cells = [];
        current_cell_ids = [];
        start_x = -7000;
        start_y = -7000;
        end_x = 7000;
        end_y = 7000;
        length_x = 14000;
        length_y = 14000;

        // minimap dom
        if ($('#mini-map-wrapper').length === 0) {
            var wrapper = $('<div>').attr('id', 'mini-map-wrapper').css({
                position: 'fixed',
                bottom: 10,
                right: 10,
                width: 400,
                height: 400,
                background: 'rgba(128, 128, 128, 0.58)'
            });

            var mini_map = $('<canvas>').attr({
                id: 'mini-map',
                width: 400,
                height: 400
            }).css({
                width: '100%',
                height: '100%',
                position: 'relative'
            });

            wrapper.append(mini_map).appendTo(document.body);

            window.mini_map = mini_map[0];
        }

        // minimap renderer
        if (render_timer === null)
            render_timer = setInterval(miniMapRender, 1000 / 30);

        // minimap location
        if ($('#mini-map-pos').length === 0) {
            window.mini_map_pos = $('<div>').attr('id', 'mini-map-pos').css({
                bottom: 10,
                right: 10,
                color: 'white',
                fontSize: 15,
                fontWeight: 800,
                position: 'fixed'
            }).appendTo(document.body);
        }

        /*
        // minimap options
        if ($('#mini-map-options').length === 0) {
            window.mini_map_options = $('<div>').attr('id', 'mini-map-options').css({
                bottom: 315,
                right: 10,
                color: '#666',
                fontSize: 14,
                position: 'fixed',
                fontWeight: 400,
                zIndex: 1000
            }).appendTo(document.body);

            var container = $('<div>')
                .css({
                    background: 'rgba(200, 200, 200, 0.58)',
                    padding: 5,
                    borderRadius: 5
                })
                .hide();

            for (var name in options) {

                var label = $('<label>').css({
                    display: 'block'
                });

                var checkbox = $('<input>').attr({
                    type: 'checkbox'
                }).prop({
                    checked: options[name]
                });

                label.append(checkbox);
                label.append(' ' + camel2cap(name));

                checkbox.click(function(options, name) { return function(evt) {
                    options[name] = evt.target.checked;
                    console.log(name, evt.target.checked);
                }}(options, name));

                label.appendTo(container);
            }

            container.appendTo(window.mini_map_options);
            var form = $('<div>')
                .addClass('form-inline')
                .css({
                    opacity: 0.7,
                    marginTop: 2
                })
                .appendTo(window.mini_map_options);

            var form_group = $('<div>')
                .addClass('form-group')
                .appendTo(form);

            var setting_btn = $('<button>')
                .addClass('btn')
                .css({
                    float: 'right',
                    fontWeight: 800,
                    marginLeft: 2
                })
                .on('click', function() {
                    container.toggle();
                    setting_btn.blur();
                    return false;
                })
                .append($('<i>').addClass('glyphicon glyphicon-cog'))
                .appendTo(form_group);

            var help_btn = $('<button>')
                .addClass('btn')
                .text('?')
                .on('click', function(e) {
                    window.open('https://github.com/dimotsai/agar-mini-map/#minimap-server');
                    help_btn.blur();
                    return false;
                })
                .appendTo(form_group);

            var addressInput = $('<input>')
                .css({
                    marginLeft: 2
                })
                .attr('placeholder', 'ws://127.0.0.1:34343')
                .attr('type', 'text')
                .addClass('form-control')
                .val('ws://127.0.0.1:34343')
                .appendTo(form_group);

            var connect = function (evt) {
                var address = addressInput.val();

                connectBtn.text('Disconnect');
                miniMapConnectToServer(address, function onOpen() {
                    miniMapSendRawData(msgpack.pack({
                        type: 0,
                        data: player_name
                    }));
                    for (var i in current_cell_ids) {
                        miniMapSendRawData(msgpack.pack({
                            type: 32,
                            data: current_cell_ids[i]
                        }));
                    }
                    miniMapSendRawData(msgpack.pack({
                        type: 100,
                        data: agar_server
                    }));
                    window.mini_map_party.show();
                }, function onClose() {
                    players = [];
                    id_players = [];
                    window.mini_map_party.hide();
                    disconnect();
                });

                connectBtn.off('click');
                connectBtn.on('click', disconnect);

                miniMapReset();

                connectBtn.blur();
            };

            var disconnect = function() {
                connectBtn.text('Connect');
                connectBtn.off('click');
                connectBtn.on('click', connect);
                connectBtn.blur();
                if (map_server)
                    map_server.close();

                miniMapReset();
            };

            var connectBtn = $('<button>')
                .css({
                     marginLeft: 2
                })
                .text('Connect')
                .click(connect)
                .addClass('btn')
                .appendTo(form_group);
        }

        // minimap party
        if ($('#mini-map-party').length === 0) {
            var mini_map_party = window.mini_map_party = $('<div>')
                .css({
                    top: 50,
                    left: 10,
                    width: 200,
                    color: '#FFF',
                    fontSize: 20,
                    position: 'fixed',
                    fontWeight: 600,
                    background: 'rgba(128, 128, 128, 0.58)',
                    textAlign: 'center',
                    padding: 10
                })
                .attr('id', 'mini-map-party')
                .appendTo(window.document.body)
                .append(
                    $('<h3>').css({
                        margin: 0,
                        padding: 0
                    }).text('Party')
                );

            var mini_map_party_list = $('<ol>')
                .attr('id', 'mini-map-party-list')
                .css({
                    listStyle: 'none',
                    padding: 0,
                    margin: 0
                })
                .appendTo(mini_map_party);

            mini_map_party.on('update-list', function(e) {
                mini_map_party_list.empty();

                for (var p in players) {
                    var player = players[p];
                    var name = String.fromCharCode.apply(null, player.name);
                    name = (name == '' ? 'anonymous' : name);
                    $('<li>')
                        .text(player.no + 1 + '. ' + name)
                        .appendTo(mini_map_party_list);
                }
            });

            mini_map_party.hide();
        }*/
    }

    // cell constructor
    function Cell(id, x, y, size, color, name) {
        cells[id] = this;
        this.id = id;
        this.ox = this.x = x;
        this.oy = this.y = y;
        this.oSize = this.size = size;
        this.color = color;
        this.points = [];
        this.pointsAcc = [];
        this.setName(name);
    }

    Cell.prototype = {
        id: 0,
        points: null,
        pointsAcc: null,
        name: null,
        nameCache: null,
        sizeCache: null,
        x: 0,
        y: 0,
        size: 0,
        ox: 0,
        oy: 0,
        oSize: 0,
        nx: 0,
        ny: 0,
        nSize: 0,
        updateTime: 0,
        updateCode: 0,
        drawTime: 0,
        destroyed: false,
        isVirus: false,
        isAgitated: false,
        wasSimpleDrawing: true,

        destroy: function() {
            delete cells[this.id];
            id = current_cell_ids.indexOf(this.id);
            -1 != id && current_cell_ids.splice(id, 1);
            this.destroyed = true;
            if (map_server === null || map_server.readyState !== window._WebSocket.OPEN) {
                miniMapUnregisterToken(this.id);
            }
        },
        setName: function(name) {
            this.name = name;
        },
        updatePos: function() {
            if (map_server === null || map_server.readyState !== window._WebSocket.OPEN) {
                if (options.enableMultiCells || -1 != current_cell_ids.indexOf(this.id)) {
                    if (! miniMapIsRegisteredToken(this.id))
                    {
                        miniMapRegisterToken(
                            this.id,
                            miniMapCreateToken(this.id, this.color)
                        );
                    }

                    var size_n = this.nSize/length_x;
                    //edit begin
                    //miniMapUpdateToken(this.id, (this.nx - start_x)/length_x, (this.ny - start_y)/length_y, size_n);
                    var originalSize = this.nSize;
                    var oPos = {x: this.nx, y: this.ny};
                    miniMapUpdateToken(this.id, (this.nx - start_x)/length_x, (this.ny - start_y)/length_y, size_n, originalSize, oPos);
                    //edit end
                }
            }

            if (options.enablePosition && -1 != current_cell_ids.indexOf(this.id)) {
                window.mini_map_pos.show();
                miniMapUpdatePos(this.nx, this.ny);
            } else {
                window.mini_map_pos.hide();
            }
        }
    };

    String.prototype.capitalize = function() {
        return this.charAt(0).toUpperCase() + this.slice(1);
    };

    function camel2cap(str) {
        return str.replace(/([A-Z])/g, function(s){return ' ' + s.toLowerCase();}).capitalize();
    };

    // create a linked property from slave object
    // whenever master[prop] update, slave[prop] update
    function refer(master, slave, prop) {
        Object.defineProperty(master, prop, {
            get: function(){
                return slave[prop];
            },
            set: function(val) {
                slave[prop] = val;
            },
            enumerable: true,
            configurable: true
        });
    };

    // extract a websocket packet which contains the information of cells
    function extractCellPacket(data, offset) {
        ////
        var dataToSend = {
            destroyQueue : [],
            nodes : [],
            nonVisibleNodes : []
        };
        ////

        var I = +new Date;
        var qa = false;
        var b = Math.random(), c = offset;
        var size = data.getUint16(c, true);
        c = c + 2;

        // Nodes to be destroyed (killed)
        for (var e = 0; e < size; ++e) {
            var p = cells[data.getUint32(c, true)],
                f = cells[data.getUint32(c + 4, true)],
                c = c + 8;
            p && f && (
                f.destroy(),
                f.ox = f.x,
                f.oy = f.y,
                f.oSize = f.size,
                f.nx = p.x,
                f.ny = p.y,
                f.nSize = f.size,
                f.updateTime = I,
                dataToSend.destroyQueue.push(f.id));

        }

        ownSizeSmallest = 0;

        // Nodes to be updated
        for (e = 0; ; ) {
            var d = data.getUint32(c, true);
            c += 4;
            if (0 == d) {
                break;
            }
            ++e;
            var p = data.getInt32(c, true),
                c = c + 4,
                f = data.getInt32(c, true),
                c = c + 4;
                g = data.getInt16(c, true);
                c = c + 2;
            for (var h = data.getUint8(c++), m = data.getUint8(c++), q = data.getUint8(c++), h = (h << 16 | m << 8 | q).toString(16); 6 > h.length; )
                h = "0" + h;

            var h = "#" + h,
                k = data.getUint8(c++),
                m = !!(k & 1),
                q = !!(k & 16);

            k & 2 && (c += 4);
            k & 4 && (c += 8);
            k & 8 && (c += 16);

            for (var n, k = ""; ; ) {
                n = data.getUint16(c, true);
                c += 2;
                if (0 == n)
                    break;
                k += String.fromCharCode(n)
            }

            n = k;
            k = null;

            var updated = false;
            // if d in cells then modify it, otherwise create a new cell
            cells.hasOwnProperty(d)
                ? (k = cells[d],
                   k.updatePos(),
                   k.ox = k.x,
                   k.oy = k.y,
                   k.oSize = k.size,
                   k.color = h,
                   updated = true)
                : (k = new Cell(d, p, f, g, h, n),
                   k.pX = p,
                   k.pY = f);

            k.isVirus = m;
            k.isAgitated = q;
            k.nx = p;
            k.ny = f;
            k.nSize = g;
            k.updateCode = b;
            k.updateTime = I;
            n && k.setName(n);

            //edit begin
            if (current_cell_ids.indexOf(d) !== -1) {
                ownX = k.nx;
                ownY = k.ny;
                if (ownSizeSmallest == 0)
                    ownSizeSmallest = k.nSize;
                else if (k.nSize < ownSizeSmallest)
                    ownSizeSmallest = k.nSize;
            }
            //edit end

            // ignore food creation
            if (updated) {
                dataToSend.nodes.push({
                    id: k.id,
                    x: k.nx,
                    y: k.ny,
                    size: k.nSize,
                    color: k.color
                });
            }
        }

        // Destroy queue + nonvisible nodes
        b = data.getUint32(c, true);
        c += 4;
        for (e = 0; e < b; e++) {
            d = data.getUint32(c, true);
            c += 4, k = cells[d];
            null != k && k.destroy();
            dataToSend.nonVisibleNodes.push(d);
        }

        var packet = {
            type: 16,
            data: dataToSend
        }

        miniMapSendRawData(msgpack.pack(packet));
    }

    // extract the type of packet and dispatch it to a corresponding extractor
    function extractPacket(event) {
        serverEvent = event;

        var c = 0;
        var data = new DataView(event.data);
        240 == data.getUint8(c) && (c += 5);
        var opcode = data.getUint8(c);
        c++;
        switch (opcode) {
            case 16: // cells data
                extractCellPacket(data, c);
                break;
            case 20: // cleanup ids
                current_cell_ids = [];
                break;
            case 32: // cell id belongs me
                var id = data.getUint32(c, true);

                if (current_cell_ids.indexOf(id) === -1)
                    current_cell_ids.push(id);

                miniMapSendRawData(msgpack.pack({
                    type: 32,
                    data: id
                }));
                break;
            case 64: // get borders
                start_x = data.getFloat64(c, !0), c += 8,
                start_y = data.getFloat64(c, !0), c += 8,
                end_x = data.getFloat64(c, !0), c += 8,
                end_y = data.getFloat64(c, !0), c += 8,
                center_x = (start_x + end_x) / 2,
                center_y = (start_y + end_y) / 2,
                length_x = Math.abs(start_x - end_x),
                length_y = Math.abs(start_y - end_y);
        }
    };

    function extractSendPacket(data) {
        var view = new DataView(data);
        switch (view.getUint8(0, true)) {
            case 0:
                player_name = [];
                for (var i=1; i < data.byteLength; i+=2) {
                    player_name.push(view.getUint16(i, true));
                }

                miniMapSendRawData(msgpack.pack({
                    type: 0,
                    data: player_name
                }));
                break;
        }
    }

    //edit begin
    function continueSendingPacket(data) {
        var view = new DataView(data);
        switch (view.getUint8(0, true)) {
            case 16:
                if (toggleBot) {
                    //console.log(view.byteLength);
                    //console.log('x: ' + view.getFloat64(1, true) + ' | y: ' + view.getFloat64(9, true));
                    return false;
                }
        }

        return true;
    }
    //edit end

    // the injected point, overwriting the WebSocket constructor
    window.WebSocket = function(url, protocols) {
        console.log('Listen');

        if (protocols === undefined) {
            protocols = [];
        }

        var ws = new _WebSocket(url, protocols);

        refer(this, ws, 'binaryType');
        refer(this, ws, 'bufferedAmount');
        refer(this, ws, 'extensions');
        refer(this, ws, 'protocol');
        refer(this, ws, 'readyState');
        refer(this, ws, 'url');

        //edit begin
        /*this.send = function(data){
            extractSendPacket(data);
            return ws.send.call(ws, data);
        };*/

        this.send = function(data){
            extractSendPacket(data);
            if (continueSendingPacket(data))
                return ws.send.call(ws, data);
        };

        //send data directly, without analyzing etc.
        this.directSend = function(data) {
            return ws.send.call(ws, data);
        };

        this.directOnMessage = function(event) {
            return this.onmessage.call(ws, event);
        };
        //edit end

        this.close = function(){
            return ws.close.call(ws);
        };

        this.onopen = function(event){};
        this.onclose = function(event){};
        this.onerror = function(event){};
        this.onmessage = function(event){};

        ws.onopen = function(event) {
            miniMapInit();
            agar_server = url;
            miniMapSendRawData(msgpack.pack({
                type: 100,
                data: url
            }));
            if (this.onopen)
                return this.onopen.call(ws, event);
        }.bind(this);

        ws.onmessage = function(event) {
            extractPacket(event);
            if (this.onmessage)
                return this.onmessage.call(ws, event);
        }.bind(this);

        ws.onclose = function(event) {
            if (this.onclose)
                return this.onclose.call(ws, event);
        }.bind(this);

        ws.onerror = function(event) {
            if (this.onerror)
                return this.onerror.call(ws, event);
        }.bind(this);

        //edit begin
        agarSocket = this; //sets agarSocket to this socket, so we can send events
        //edit end
    };

    window.WebSocket.prototype = _WebSocket;

    $(window.document).ready(function() {
        miniMapInit();
    });

    $(window).load(function() {
        var main_canvas = document.getElementById('canvas');
        if (main_canvas && main_canvas.onmousemove) {
            document.onmousemove = main_canvas.onmousemove;
            main_canvas.onmousemove = null;
        }

        //edit begin
        $(window).keydown(function(evt) {
            if (event.which == 69) { //move to 0/0 ?
                toggleBot = !toggleBot;
                console.log('Bot is ' + (toggleBot?'active':'paused') );
            }
        });
        //edit end
    });
})();
