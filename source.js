document.addEventListener('DOMContentLoaded', (event) => {

    //On-Load Enviroment Settings
    setActiveTab("log-tab");


    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
       
    function convertJson(str) { //Converts "pretty" string JSON to JSON object
        return JSON.parse(str);
    }

    function sendRequestWithData(url, data) { //Sends request with data to url, doesnt return
        const Http = new XMLHttpRequest();
        Http.open("POST", url);
        Http.setRequestHeader("Content-Type", "application/json");
        Http.send(JSON.stringify(data));
    }
    
    function sendNullRequest(url) { //Sends request with no data to url
        const Http = new XMLHttpRequest();
        Http.open("POST", url);
        Http.send();
    }
    
    function sendNullWithResponse(url) { //Sends request with no data to url, returns response sync
        const Http = new XMLHttpRequest();
        Http.open("POST", url);
        Http.send();
        Http.onreadystatechange = function () {
            if (this.readyState == this.DONE) {
                return this.responseText;
            }
        }
    }

    function postAndScrollDown(txt) { //Posts text to console object, if text is different then what is already being displayed
        const txtArea = document.getElementById('console');
        if (txt.trim() != txtArea.value.trim()) {
            txtArea.value = txt;
            txtArea.scrollTop = txtArea.scrollHeight;
        }
    };

    function switchTab(target) {
        document.getElementById(target).click();
    }

    function setActiveTab(tab) { //Sets active tab in localStorage
        localStorage.setItem("active-tab", tab);
        var con = document.getElementById('console');
        if (tab == "Values-tab") { //If tab is Values, allows for saving and editing of data
            saveButton.disabled = false;
            con.disabled = false;

        }
        else {
            saveButton.disabled = true;
            con.disabled  = true;
        }
        if (tab == "log-tab") { //If tab is log tab, posts log to screen
            getLog();
        }
        else {
            setDataToTab(tab);
        }
    };

    function getActiveTab() {
        var tab = localStorage.getItem("active-tab");
        return tab;
    };

    function setDataToTab(tab) {
        const tabData = document.getElementById(tab).value;
        const Http = new XMLHttpRequest();
        var url = "/data";
        Http.open("POST", url);
        Http.setRequestHeader("Content-Type", "application/json");
        Http.send(JSON.stringify({"document":tabData}));
        Http.onreadystatechange = function () {
            if (this.readyState == this.DONE) {
                localStorage.setItem(tab, JSON.stringify(JSON.parse(this.response), null, "\n\t"));
                postAndScrollDown(localStorage.getItem(tab));
            }
        }
    };

    function getLog() {
        const Http = new XMLHttpRequest();
        var url = "/log";
        Http.open("POST", url);
        Http.send();
        Http.onreadystatechange = function () {
            if (this.readyState == this.DONE) {
                if (getActiveTab() == "log-tab") { //If current tab is log tab, post data
                    postAndScrollDown(this.responseText);
                }
                else { //If active tab is not log, save data
                    localStorage.setItem("log", this.responseText);
                }
                
            }
        }
    };getLog();setInterval(getLog, 1000);


    var consoleTabs = document.getElementsByName("console-tabs")
    for (let x = 0; x < consoleTabs.length; x++) {
        consoleTabs[x].onclick = function() {         
            if (this.id != getActiveTab()) {
                setActiveTab(this.id);
            }       
        }
    }

    //Shutdown button listener
    var serverSwitch = document.getElementById("server-io-switch");
    $(serverSwitch).change(async function() {
        if (this.checked == false) {
            ioSwitch.checked = false;
            sendNullRequest("/shutdown");
            postAndScrollDown("Goodbye!");
            await sleep(2000);
            location.reload();            
        }

    });

    //New on-off slider for bot
    var ioSwitch = document.getElementById("discord-io-switch");
    $(ioSwitch).change(async function() {
        if (this.checked) {
            const Http = new XMLHttpRequest();
            Http.open("POST", "/on");
            Http.send();
            Http.onreadystatechange = function () {
                if (this.readyState == this.DONE) {
                    if (this.responseText == "Missing Values") {
                        ioSwitch.checked = false;
                        alert("Error: Missing Values.\nCheck to see that all fields are filled.")
                        switchTab("Values-tab");
                    } 
                }
            }
            
        }
        else {
            sendNullRequest("/off");
        }
    });
    

    //On-Off Sliders for radarr and sonarr within form area
    var radsonSwitches =  document.getElementsByName("radson-io-switch");
    for (let x = 0; x < radsonSwitches.length; x++) {
        var s = radsonSwitches[x];
        $(s).change(async function() {
            url = "/enable";
            if (this.checked) {
                const j = {[this.value] : true};
                sendRequestWithData(url, j);
            }
            else {
                const j = {[this.value] : false};
                sendRequestWithData(url, j);
            }
        });
    }

    //Opening form tab
    document.getElementById("set-values-tab").onclick = function() {
        switchTab("Values-tab");
    }

    //Discord Save button listener
    document.getElementById("saveButton").onclick = function() {
        const txtAreaJson = JSON.parse(document.getElementById("console").value);
        var fileName = document.getElementById(getActiveTab()).value;
        var j = {"data":txtAreaJson, "file":fileName}
        sendRequestWithData("/save", j);
        switchTab("log-tab");
    }

    //Form Save button listener
    document.getElementById("cred-form-save").onclick = function() {
        const values = document.getElementsByName("cred-form-field");
        const txtAreaJson = JSON.parse(document.getElementById("console").value);
        for (let x = 0; x < values.length; x++) {
            txtAreaJson[values[x].id] = values[x].value;
        }
        var j = {"data":txtAreaJson, "file":"values"};
        sendRequestWithData("/save", j);
        document.getElementById("close-form").click();
        switchTab("log-tab");
    }
    
    //User Add button listener
    document.getElementById("cred-form-add").onclick = function() {
        const input = document.getElementById("added-user");
        var j = {"user":input.value};
        sendRequestWithData("/adduser", j);
        input.value = "";
        document.getElementById("close-form").click();
        switchTab("log-tab");
    }

    //Admin Add button listener
    document.getElementById("cred-form-admin").onclick = function() {
        const input = document.getElementById("added-admin");
        var j = {"admin":input.value};
        sendRequestWithData("/adduser", j);
        input.value = "";
        document.getElementById("close-form").click();
        switchTab("log-tab");
    }

    //Autocomplete for Admin
    


    
});