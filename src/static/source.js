document.addEventListener('DOMContentLoaded', (event) => {
     
    
    // ------------------ STARTUP EVENTS -----------------------------

    // Start websocket connection when page is loaded
    const socket = io.connect(window.location.origin)
    
    // Tell the web-server that we've connected, say hi
    socket.emit('client_connect', {
        message: 'hello server'
    }); // Returns on 'client_info'

    // When we've said hi to the server, itll send us all the data we need to populate screen
    socket.on('client_info', (data) => {
        console.log(data);
        updateCurrentStatus(data.state);
        updateSwitches(data.state);
        updateConfigFields(data.config);
        updateLog(data.log);
        updateUsers(data.users);
    }); // how rude

    // ----- MODAL RECURSION FIX --------
    $.fn.modal.Constructor.prototype.enforceFocus = function () {};

    // ----- IS THIS MOBILE DEV ---------
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

    // ------------------ CONFIGURATION EVENTS -----------------------------
    
    // Configuration elements
    const saveButton =  document.getElementById('config-save-button');
    const configPopOver = document.getElementById('offcanvasConf');

    // When the configuration has been updated on the backend
    socket.on('config_updated', (data) => {
        const isPopVisible = window.getComputedStyle(configPopOver)
            .getPropertyValue('visibility') === 'visible' ? true : false;
        if (data.error) {
            alert(data.error);
        } else if (isPopVisible) {
            document.getElementById('close-conf-form').click();
        } 
    });

    // Generate a configuration field for text input
    const generateCharFormField = (parentTag, val, fieldName, verboseFieldName) => {
        parentTag.innerHTML += `
        <div>
            <div class="input-group mb-3 form-floating">
                <input type="text" class="form-control input-format-1 input-format-config" id="${fieldName}" name="cred-form-field" placeholder="${verboseFieldName}"
                aria-label="${verboseFieldName}" aria-describedby="field-${verboseFieldName}" value="${val}">
                <label for="${fieldName}">${verboseFieldName}</label>
            </div>
        </div>`
    };

    // Generate a configuration field for number input
    const generateIntFormField = (parentTag, val, fieldName, verboseFieldName) => {
        parentTag.innerHTML += `
        <div>
            <div class="input-group mb-3 input-group-number form-floating">
                <input type="text" class="form-control input-format-1 input-format-config" id="${fieldName}" name="cred-form-field" placeholder="${verboseFieldName}"
                    aria-label="${verboseFieldName}" aria-describedby="field-${verboseFieldName}" value="${val}" inputmode="numeric"
                    onInput="this.value = this.value.replace(/[^0-9-]|(?<!^)-/g, '')" required>
                <label for="${fieldName}">${verboseFieldName}</label>
            </div>
            
        </div>`
    };

    // Generate a configuration field for a boolean input
    const generateFormSwitch = (parentTag, val, fieldName, verboseFieldName) => {
        parentTag.innerHTML += `
        <div class="form-check form-switch">
            <input class="form-check-input input-format-1" type="checkbox" role="switch" name="cred-form-field" id="${fieldName}" ${(val) ? 'checked' : ''}>
            <label class="form-check-label" for="${fieldName}">${verboseFieldName}</label>
        </div>`
    };

    // Populates configuration fields with passed in values
    const updateConfigFields = (data) => {
        const configContainer = document.getElementById('config-container');
        configContainer.innerHTML = '';
        const configFields = Object.keys(data.fields);
        configFields.forEach((field) => {
            if(field && field !== 'id') {
                const verboseName = data.verbose[field];
                const fieldType = data.types[field];
                const currentVal = data.fields[field] ? data.fields[field] : '';
                let fieldGen;
                switch(fieldType) {
                    case 'VARCHAR':
                        fieldGen = generateCharFormField;
                        break;
                    case 'INT':
                        fieldGen = generateIntFormField;
                        break;
                    case 'BOOL':
                        fieldGen = generateFormSwitch;
                        break;
                    default:
                        break;
                }
                fieldGen(
                    configContainer,
                    currentVal,
                    field,
                    verboseName
                );
                
            }
            
        });
    };

    // Gets all the values from the configuration form, packs them into an object
    const getConfigFromFields = () => {
        const fieldData = document.getElementsByName('cred-form-field');
        const preparedData = {};
        fieldData.forEach((fieldInput) => {
            if (!fieldInput.value) {
                return null;
            } else if (fieldInput.type === 'checkbox') {
                preparedData[fieldInput.id] = fieldInput.checked;
            } else {
                preparedData[fieldInput.id] = fieldInput.value;
            }
        });
        return preparedData;
    };

    // Sends that object (look up) back to the server
    const saveConfigInFields = () => {
        const data = getConfigFromFields();
        socket.emit('update_config', data);
    };
    
    // When save button is clicked, send back configs
    saveButton.onclick = (event) => {
        saveConfigInFields();
    };

    // ------------------ USER EVENTS -----------------------------

    // User Table/Popover Elements
    const offcanvasUserButton = document.getElementById('offcanvasUser-button');
    const userInput = document.getElementById('user-add-input');
    const userInputButton = document.getElementById('user-add-input-button');
    const userInputButtonHidden = document.getElementById('user-add-input-button-hidden');
    const userTable = document.getElementById('user-table-body');
    const userBody = document.getElementById('user-body');
    const userPopOver = document.getElementById('offcanvasUser');
    const userPopOverClose = document.getElementById('close-user-form');
    const userSuggestDatalist = document.getElementById('user-input-datalist');
    const userFilterInput = document.getElementById('user-search-input');
    
    // Add/Edit User Modal Elements
    const addedUserModalLabel = document.getElementById('addedUserModalLabel');
    const addedUserModalConfirmButton = document.getElementById('addedUserModalConfirmButton');
    const addedUserUsernameField = document.getElementById('addedUserUsername');
    const addedUserIsAdminField = document.getElementById('addedUserIsAdmin');
    const addedUserIsAdminFieldLabel = document.getElementById('addedUserIsAdminFieldLabel');
    const addedUserIsAdminFieldSecLabel = document.getElementById('addedUserIsAdminFieldSecLabel');
    const addedUserServerTableBody = document.getElementById('addedUserDiscordServerTableBody');
    const addedUserServerDiv = document.getElementById('addedUserServerDiv');
    const addedUserServerAllOrSomeButton = document.getElementById('addedUserIsServerRestricted');
    const addedUserServerRefreshButton = document.getElementById('addedUserServerTableRefresh');
    const addedUserId = document.getElementById('addedUserId');

    // To populate the auto-suggestions when typing in a user
    socket.on('unadded_users_sent', (data) => {
        userSuggestDatalist.innerHTML = '';
        data.unadded.forEach((user) => {
            userSuggestDatalist.innerHTML += `<option value="${user}">`
        });
    });

    // When a user has been added to the DB on the backend
    socket.on('users_updated', (data) => {
        updateUsers(data.users);
    });

    // Reset the added user modal to it's blank state
    const resetAddedUserModal = () => {
        addedUserUsernameField.value = '';
        userFilterInput.value = '';
        addedUserId.value = '';
        $("#user-table tbody tr").show();
        if (addedUserIsAdminField.checked) {
            addedUserIsAdminField.click();
        }
        if (!addedUserServerAllOrSomeButton.checked) {
            addedUserServerAllOrSomeButton.click();
        }
        addedUserServerTableBody.innerHTML = '';
    };

    // Generates user rows in user management table
    const generateUserRow = (parentTag, user) => {
        parentTag.innerHTML += `
        <tr class="user-row">
            <th name="user-id-row" scope="row">${user.id}</th>
            <td name="username-row">${user.username}</td>
            <td name="isadmin-row">${user.is_admin ? 'Admin': 'Non-Admin'}</td>
            <td name="isrestricted-row">${user.is_server_restricted ? 'Some Servers': 'All Servers'}</td>
            <td name="added-date-row">${user.added}</td>
        </tr>`;
    };

    // Generates server rows in added user modal server table
    const generateServerRows = (servers) => {
        addedUserServerTableBody.innerHTML = '';
        servers.forEach((server) => {
            addedUserServerTableBody.innerHTML += `
            <tr class="server-row" id="addedUserServer-${server.server_id}" data-id='${server.server_id}' data-value='${server.server_name}' name="added-user-form-field">
                <td>
                    <label class="add-server-btn" id="addedUserServer-${server.server_id}-Label">${server.active ? "Remove": "Add"}</label>
                </td>
                <td>${server.server_name}</td>
                <td>${server.server_id}</td>
            </tr>`;
        });

        const rows = addedUserServerTableBody.querySelectorAll('.server-row');
        rows.forEach((row) => {
            const label = document.getElementById(`addedUserServer-${$(row).data('id')}-Label`);
            row.onclick = (e) => {
                label.innerHTML = label.innerHTML === 'Add' ? 'Remove' : 'Add';
            };
        });
    };

    // Updates users in user management table
    const updateUsers = (data) => {
        userTable.innerHTML = '';
        data.forEach((user) => {
            generateUserRow(userTable, user);
        });
        const rows = userTable.querySelectorAll('.user-row');
        rows.forEach((row) => {
            row.onclick = (e) => {
                editUser(row);
            };
        });
    };

    // Gathers the date from the added user modal, packs it into an object
    const getAddedUserInfoFromFields = () => {
        const fieldData = document.getElementsByName('added-user-form-field');
        const preparedData = {};
        preparedData['servers'] = [];
        fieldData.forEach((fieldInput) => {
            
            if (!fieldInput.value && !$(fieldInput).data('value')) {
                return null;
            } else if (fieldInput.className == 'server-row') { // Parsing servers from table
                const added = document.getElementById(`${fieldInput.id}-Label`).innerText === 'Remove';
                if (added) {
                    preparedData['servers'].push({
                        server_name: $(fieldInput).data('value'),
                        server_id: $(fieldInput).data('id')
                    });
                }
            } else if (fieldInput.id === 'addedUserIsServerRestricted') {
                console.log('field input for is_server_restricted is ', fieldInput);
                preparedData[$(fieldInput).data('value')] = !fieldInput.checked;
            } else if (fieldInput.type === 'checkbox') {
                preparedData[$(fieldInput).data('value')] = fieldInput.checked;
            } else {
                preparedData[$(fieldInput).data('value')] = fieldInput.value;
            }
        });
        return preparedData;
    }

    // Gets all servers from DB. If user is in a server, 'active' is true
    const getAllServers = (username) => {
        socket.emit('request_servers_from_client', { 'username': username }, (data) => {
            generateServerRows(data['servers']);
        });
    };

    // When Enter is pressed within user input field, click '+' button
    userInput.onkeydown = (e) => {
        if (e.code === 'Enter') {
            userInputButton.click();
        }
    };

    // When '+' button is clicked
    userInputButton.onclick = (e) => {
        // If username is less that 4 characters, animate and reject input
        if (userInput.value.length < 4) {
            userInput.classList.add('input-format-user-err');
            let [tmpVal, tmpPh] = [userInput.value, userInput.placeholder];
            userInput.value = '';
            userInput.placeholder = 'Invalid Username...';
            setTimeout(() => {
                userInput.classList.remove('input-format-user-err');
                [userInput.value, userInput.placeholder] = [tmpVal, tmpPh];
            }, 500);
            return;
        }
        resetAddedUserModal();
        // Remove any warnings or errors
        showOrHideFeedback(false);
        addedUserModalLabel.innerText = 'Add User';
        // Set username field in add user modal to the first input field's value
        addedUserUsernameField.value = userInput.value;
        // Click the hidden button that dismisses the previous modal and opens add user
        userInputButtonHidden.click();
    };

    // Given an object/dict for a user, populate those fields in "edit user" modal. 
    const populateUserModal = (userDict, userId) => {
        resetAddedUserModal();
        addedUserId.value = userId;
        addedUserUsernameField.value = userDict.username;
        if (userDict.is_admin) {
            addedUserIsAdminField.click();
        }
        if (userDict.is_server_restricted) {
            addedUserServerAllOrSomeButton.checked = false;
            document.getElementById('addedUserIsServerRestrictedLabel')
                .innerText = 'Some Servers';
            document.getElementById('addedUserIsServerRestrictedSecLabel')
                .innerText = '< Change to all servers';
            addedUserServerDiv.hidden = false;
        } else {
            addedUserServerDiv.hidden = true;
        }
        // Get all servers regardless if hidden.
        // Added servers are persistent data even if overridden by !is_server_restricted
        getAllServers(userDict.username);
    };

    // Convert add user modal to edit user modal, populate with selected user's values
    const editUser = (row) => {
        showOrHideFeedback(false);
        const userId = row.querySelector('th[name="user-id-row"]').innerText;
        socket.emit('get_user_info_from_id', { id: userId }, (resp) => {
            console.log(resp);
            populateUserModal(resp, userId);
            addedUserModalLabel.innerText = 'Edit User';
            userInputButtonHidden.click();
        });

    };

    // Filter user management table
    $(userFilterInput).on("keyup", function() {
        var value = $(this).val().toLowerCase();
        userBody.scrollTo({
            top: 0,
            behavior: 'smooth'
        });
        $("#user-table tbody tr").filter(function() {
            // Toggling table rows if stringified tr does not contain substring
            var row = $(this);
            var columns = row.find("td");
            var found = false;
            columns.each(function() {
                var column = $(this);
                var text = column.text();
                var lowerText = text.toLowerCase();
                if (value && lowerText.indexOf(value) > -1) {
                    // Highlight the substring within the column
                    var startIndex = lowerText.indexOf(value);
                    var endIndex = startIndex + value.length;
                    var highlightedText = text.substring(0, startIndex) +
                        '<span class="highlighted">' + text.substring(startIndex, endIndex) + '</span>' +
                        text.substring(endIndex);
                    column.html(highlightedText);
                    found = true;
                } else {
                    column.html(text);
                }
            });
            if (found) {
                row.show();
            } else {
                row.hide();
            }
            if (value.length === 0) {
                $("#user-table tbody tr").show();
            }
        });
      });

    userPopOverClose.onclick = (e) => {
        resetAddedUserModal();
    }
    
    // When Confirm in added user modal is pressed
    const userWarningSet = new Set();
    addedUserModalConfirmButton.onclick = (e) => {
        const userInfo = getAddedUserInfoFromFields();
        if (userInfo.is_server_restricted && userInfo.servers.length < 1)
        {
            if (!userWarningSet.has(userInfo.username)) {
                showOrHideFeedback(true, 'WARNING:\n\n' +
                'You are attempting to save a user with no servers specified!\n\n' +
                'If this is not a discord-user, disregard this message.\n\nOtherwise, ' +
                'be aware that the bot will not recognize commands from this user ' +
                'until their server is added here OR you change the scope to "All Servers".');
                userWarningSet.add(userInfo.username);
                return;
            } else {
                showOrHideFeedback(false);
                userWarningSet.delete(userInfo.username);
            }
        }
        const serverRoute = addedUserModalLabel.innerText === 'Add User' ?
            'add_user_from_client' : 'edit_user_from_client';
        socket.emit(serverRoute, { user_info: userInfo }, (response) => {
            if (response.error) {
                showOrHideFeedback(true, `ERROR:\n\n${response.error}`);
                setTimeout(showOrHideFeedback, 15000);
            } else {
                document.getElementById('addedUserModalConfirmButtonHidden').click();
                userInput.value = '';
            }
        });
    };

    // When error in added user modal
    const showOrHideFeedback = (show=false, msg='') => {
        const feedback = document.querySelector('.invalid-feedback');
        if (show) {
            feedback.style.display = 'inline';
            feedback.innerText = msg;
          } else {
            feedback.style.display = 'none';
            feedback.innerText = '';
          }
    };

    // When user management popover is opened.
    offcanvasUserButton.onclick = (e) => {
        socket.emit('get_unadded_users', { message: 'Requesting unadded users' });
    };

    // When Refresh button is clicked in add user modal
    addedUserServerRefreshButton.onclick = (e) => {
        getAllServers(addedUserUsernameField.value);
    };

    // When All Servers/Some Servers checkbox is checked/unchecked in add/edit user modal
    addedUserServerAllOrSomeButton.onchange = (e) => {
        const label = document.getElementById('addedUserIsServerRestrictedLabel');
        const secLabel = document.getElementById('addedUserIsServerRestrictedSecLabel');
        if (!addedUserServerAllOrSomeButton.checked) {
            getAllServers(addedUserUsernameField.value);
            label.innerText = 'Some Servers';
            secLabel.innerText = '< Change to all servers';
        } else {
            label.innerText = 'All Servers';
            secLabel.innerText = '< Change to some servers';
        }
        addedUserServerDiv.hidden = !addedUserServerDiv.hidden;
    };

    // When admin checkbox is checked/unchecked in add/edit user modal
    addedUserIsAdminField.onchange = (e) => {
        if (addedUserIsAdminField.checked) {
            addedUserIsAdminFieldLabel.innerText = 'Admin';
            addedUserIsAdminFieldSecLabel.innerText = '< Change role to non-admin';
        } else {
            addedUserIsAdminFieldLabel.innerText = 'Non-Admin';
            addedUserIsAdminFieldSecLabel.innerText = '< Change role to admin';
        }
    };

    // ------------------ STATE EVENTS -----------------------------
    
    // On/Off switch elements for bots and web-server
    const serverSwitch = document.getElementById("server-io-switch");
    const discordBotSwitch = document.getElementById("discord-io-switch");
    const telegramBotSwitch = document.getElementById("telegram-io-switch");

    // When a new status is recieved, update status bar above console
    socket.on('update_status', (data) => {
        updateCurrentStatus(data);
    });

    // Update status bar to reflect current status
    const updateCurrentStatus = (data) => {
        const statusBox = document.getElementById('status-box');
        statusBox.innerHTML = data['current_activity'];
    };

    const requestStatusUpdate = (statusStr) => {
        socket.emit('change_client_status', { status: statusStr });
    }

    // Update on/off switches to reflect current values
    const updateSwitches = (data) => {
        serverSwitch.checked = data['app_state'];
        discordBotSwitch.checked = data['discord_state'];
        telegramBotSwitch.checked = data['telegram_state'];
    };

    // Start shutdown of server, shutsdown after 5 seconds
    const serverSwitchShutdown = (sw) => {
        sw.classList.add('custom-check-loading');
        // Save current status to global if cancelled
        window.status = document.getElementById('status-box').innerHTML;
        requestStatusUpdate('Starting shutdown. Cancel by moving switch to \'on\' position.')
        // Starting timer that allows cancellation of shutdown
        window.serverSwitchTimer = setTimeout(() => {
            sw.classList.remove('custom-check-loading');
            discordBotSwitch.checked = false;
            telegramBotSwitch.checked = false;
            socket.emit('server_off', {
                message: 'SERVEROFF'
            }); 
            location.reload(); 
        }, 5000);
    };

    // Cancels shutdown of server
    const clearServerShutdown = (sw) => {
        // If timer exists and previous status being held in memory
        if (window.serverSwitchTimer && window.status) {
            // Revert class to default (green glow)
            sw.classList.remove('custom-check-loading');
            clearTimeout(window.serverSwitchTimer);
            requestStatusUpdate(window.status);
            window.serverSwitchTimer = null;
            window.status = null;
        } else {
            alert('Server shutdown was not in progress.')
            sw.checked = true;
        }  
    };

    // On server switch event
    serverSwitch.onchange = (e) => {
        if (!serverSwitch.checked) {
            serverSwitchShutdown(serverSwitch);
        } else {
            clearServerShutdown(serverSwitch);
        }
    };

    // Returns switch element based on passed in data
    const getSwitchFromData = (data) => {
        switch(data.bot_name) {
            case 'discord':
                return discordBotSwitch;
            case 'telegram':
                return telegramBotSwitch;
            default:
                return null;
        };
    };

    // Shutdown bot and re-enable switch after one second
    const botSwitchShutdown = (name, sw) => {
        sw.classList.add('custom-check-loading');
        setTimeout(() => {
            socket.emit('bot_off', {
                message: 'BOTOFF',
                bot_name: name
            });
            sw.disabled = false;
        }, 1000)
    };

    // Begins startup process. Issues startup command to server, expecting eventual response (bot_on_finished)
    const botSwitchStartup = (name, sw) => {
        sw.classList.add('custom-check-loading');
        socket.emit('bot_on', {
            message: 'BOTON',
            bot_name: name
        }, (resp) => {
            if (!resp.success) {
                alert(resp.error);
                sw.disabled = false;
                sw.checked = false;
                sw.classList.add('custom-check-failed');
                sw.classList.remove('custom-check-loading');
            }
        });
        
    };

    // On bot switch event
    discordBotSwitch.onchange = (e) => {
        discordBotSwitch.disabled = true;
        if (!discordBotSwitch.checked) {
            botSwitchShutdown('discord', discordBotSwitch);       
        } else {
            botSwitchStartup('discord', discordBotSwitch);
        }
    };

    // On bot switch event
    telegramBotSwitch.onchange = (e) => {
        telegramBotSwitch.disabled = true;
        if (!telegramBotSwitch.checked) {
            botSwitchShutdown('telegram', telegramBotSwitch);       
        } else {
            botSwitchStartup('telegram', telegramBotSwitch);
        }
    };
    
    // Response from server after finishing/err on bot startup
    socket.on('bot_on_finished', (data) => {
        const sw = getSwitchFromData(data);
        sw.disabled = false;
        if (data.error) {
            alert(data.error);
            sw.checked = false;
            sw.classList.add('custom-check-failed');
            sw.classList.remove('custom-check-loading');
        } else if (data.success) {
            sw.classList.remove('custom-check-loading');
        }
    });

    // Response from server after finishing/err on bot startup
    socket.on('bot_off_finished', (data) => {
        const sw = getSwitchFromData(data);
        sw.disabled = false;
        if (data.success) {
            sw.classList.remove('custom-check-loading');
            requestStatusUpdate('Offline');
        } else {
            alert('Encountered error on shutdown')
            sw.classList.add('custom-check-failed');
            sw.classList.remove('custom-check-loading');
        }
    });

    // ------------------ LOG EVENTS -----------------------------

    // Console elem
    var logTxt = document.getElementById('console');

    // Update console log to reflect current logs
    const updateLog = (data) => {
        let buf = '';
        data.forEach((log) => {
            buf += `${log}\n`;
        });
        logTxt.value = buf;
        logTxt.scrollTo({
            top: logTxt.scrollHeight,
            behavior: 'smooth'
        });
    };

    // When a log is added to the DB on the server
    socket.on('bot_log_added', (data) => {
        updateLog(data.log);
    });
});

