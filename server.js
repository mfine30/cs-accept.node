// core-services acceptance
// A Web app which will allow writing data to p-mysql and/or p-riakcs
//   - test that the services have been installed and configured correctly
//   - a visual way to validate that data is durable across upgrades, etc.
//
// NOTE: To run in local mode, provide a VCAP_SERVICES env variable like this:
// VCAP_SERVICES={"p-mysql":[{"credentials":{"uri":"mysql://user:password@127.0.0.1/latticeDB"}}]}

var finalhandler = require('finalhandler') ;
var http = require('http') ;
var serveStatic = require('serve-static') ;
var strftime = require('strftime') ;
var time = require('time') ;
var url = require('url') ;
var util = require('util') ;
var mysql = require('mysql') ;

// CONFIGURE THESE
var numSecondsStore = 600 // Default 10 minutes

// Variables
var data = "" ;
var activateState = Boolean(false) ;
var pm_uri = "" ;
var vcap_services = undefined ;
var pm_credentials = undefined ;
var dbClient = undefined ;
var dbConnectState = Boolean(false) ;
var dbConnectTimer = undefined ;
var riakcs_credentials = undefined ;
var riakcsClient = undefined ;
var riakcsConnectionState = Boolean(false) ;

// Setup based on Environment Variables
if (process.env.VCAP_SERVICES) {
    vcap_services = JSON.parse(process.env.VCAP_SERVICES) ;
    if (vcap_services['p-mysql']) {
        pm_credentials = vcap_services["p-mysql"][0]["credentials"] ;
        pm_uri = pm_credentials["uri"] ;
        console.log("Got access credentials to database: " + pm_uri) ;
        activateState="mysql" ;
    }
    if (vcap_services['riakcs']) {
        riakcs_credentials = vcap_services["riakcs"][0]["credentials"] ;
        console.log("Got access credentials to riakcs: " + JSON.stringify(riakcs_credentials)) ;
    }
}

if (process.env.VCAP_APP_PORT) { var port = process.env.VCAP_APP_PORT ;}
else { var port = 8080 ; }
if (process.env.CF_INSTANCE_INDEX) { var myIndex = JSON.parse(process.env.CF_INSTANCE_INDEX) ; }
else { myIndex = 0 ; }
var myInstance = "Instance_" + myIndex + "_Hash" ;
var myInstanceBits = "Instance_" + myIndex + "_Bits" ;

function setupSchema() {
    dbClient.query("show tables LIKE 'SampleData'", function(err, results, fields) {
        if (err) {
            console.error(err) ;
            process.exit(1) ;
        } else {
            if (0 == results.length) {
                console.log("Setting up schema.") ;
                dbClient.query("create table SampleData (K VARCHAR(20), V VARCHAR(20))",
                               function (err, results, fields) {})
            } else {
                console.log("Table exists.") ;
            }
        }
    }) ;
}
    
// Callback functions

function handleDBerror(err) {
    if (err) {
        console.warn("Issue with database, " + err.code + ". Attempting to reconnect every 1 second.")
        setTimeout(MySQLConnect, 1000) ;
    }
}

function handleDBConnect(err) {
    if (err) {
        dbConnectState = false ;
        console.error("ERROR: problem connecting to DB: " + err.code +
                      ", will try again every 1 second.") ;
        dbConnectTimer = setTimeout(MySQLConnect, 1000) ;
    } else {
        console.log("Connected to database.") ;
        dbClient.on('error', handleDBerror) ;
        dbConnectState = true ;
        if (dbConnectTimer) {
            clearTimeout(dbConnectTimer) ;
            dbConnectTimer = undefined ;
        }
        setupSchema() ;
    }
}

function handleDBping(request, response, err) {
    if (err) {
        console.log("MySQL Connection error: " + err) ;
        response.end("MySQL connection error: " + err) ;
        dbClient.destroy() ;
        MySQLConnect() ;
    } else {
        response.end("MySQL ping successful.") ;
    }
}

function handleRiakcsConnect(message, err) {
    console.log("handleRiakcsConnect called with message: " + message) ;
    switch (message) {
    case "error":
        riakcsConnectionState = false ;
        console.log("Riakcs connection failed: " + err + "\nWill try again in 3s." ) ;
        setTimeout(RiakcsConnect, 3000) ;
        break ;
    case "ready":
        riakcsConnectionState = true ;
        riakcsClient.hget(myInstance, "lastKeyUpdated", handleLastKey) ;
        riakcsClient.hget(myInstance, "lastUpdate", handleLastTime) ;
        console.log("Riakcs READY.") ;
        break ;
    }
}
        

// Helper functions

function doPing(request, response) {
    dbClient.ping(function (err) {
        handleDBping(request, response, err) ;
    }) ;
}

function MySQLConnect() {
    if (activateState) {
        dbClient = mysql.createConnection(pm_uri)
        dbClient.connect(handleDBConnect) ;
    } else {
        dbClient = undefined ;
    }
}

function sql2json(request, response, error, results, fields) {
    if (error) {
        dbError(response, error) ;
    } else {
        var dataSet = [] ;
        for (var kv in results) {
            dataSet.push( [ results[kv]['K'], results[kv]['V'] ] ) ;
        }
        response.end(JSON.stringify(dataSet)) ;
    }
}

function valuesPage(request, response, tableHTML) {
    pageHTML = "<h1>Core Services Acceptance</h1>\n" ;
	  pageHTML += "<p>" + strftime("%Y-%m-%d %H:%M") + "<br>\n" ;
    pageHTML += "<center>" + tableHTML + "</center><br>" ;
	  pageHTML += "Database connection info: " + pm_uri + "<br>\n" ;
    pageHTML += "</p>\n<hr>\n" ;
    pageHTML += "<A HREF=\"" + url.resolve(request.url, "/env") + "\">/env</A>  " ;
    pageHTML += "<A HREF=\"" + url.resolve(request.url, "/ping") + "\">/ping</A>\n" ;

    response.end(pageHTML) ;
}

function handleValuesRequest(request, response, error, results, fields) {
    if (error) {
        dbError(response, error) ;
    } else {
        tableHTML = "<table border=1><tr><th>Key</th><th>Value</th></tr>\n" ;
        for (var kv in results) {
            result = results[kv] ;
            tableHTML += "<tr><td>" + result['K'] + "</td><td>"
                + result['V'] + "</td></tr>\n" ;
        }
        tableHTML += "</table>\n" ;

        // At last we can return a values Page
        valuesPage(request, response, tableHTML) ;
    }
}

function handleWriteRequest(request, response, error, results, fields) {
    if (error) { dbError(response, error) }
    else {
        pageHTML = "<h1>Write successful.</h1>\n" ;
        pageHTML += "<hr>\n" ;
        pageHTML += "<A HREF=\"" + url.resolve(request.url, "/") + "\">HOME</A>  " ;
        pageHTML += "<A HREF=\"" + url.resolve(request.url, "/env") + "\">/env</A>  " ;
        pageHTML += "<A HREF=\"" + url.resolve(request.url, "/ping") + "\">/ping</A>\n"
        ;
        response.end(pageHTML) ;
    }
    return(true) ;
}

function dbError(response, error) {
    console.error("ERROR getting values: " + error) ;
    response.end("ERROR getting values: " + error) ;
}
    
function errorDbNotReady(request, response) {
    console.error("ERROR: Database is Not Ready") ;
    errHTML = "<title>Error</title><H1>Error</H1>\n"
    errHTML += "<p>Database info is not set or DB is not ready<br>\n" ;
    errHTML += "<hr><A HREF=\"" + url.resolve(request.url, "/dbstatus") + "\">/dbstatus</A>\n" ;
    response.end(errHTML) ;
}

function readTable(request, response, table, callBack) {
    if ("mysql" == activateState && dbConnectState) {
        dbClient.query('SELECT K, V from ' + table,
                       function (error, results, fields) {
                           callBack(request, response, error, results, fields) ;
                       }) ;
    } else {
        errorDbNotRead(request, response) ;
    }
}

function writeSomething(request, response, key) {
    if ("mysql" == activateState && dbConnectState) {
        var timeStamp = strftime("%Y-%m-%d %H:%M") ;
        var sql = "insert into SampleData VALUES ('" + key + "','" + timeStamp + "')" ;
        console.log("SQL: " + sql ) ;
        dbClient.query(sql, function (error, results, fields) {
            handleWriteRequest(request, response, error, results, fields) ;
        }) ;
    } else {
        errorDbNotReady(response, error) ;
    }
}

function dispatchApi(request, response, method, query) {
    switch (method) {
    case "dbstatus":
        response.end(JSON.stringify({"dbStatus":dbConnectState})) ;
        break ;
    case "read":
        if (query["table"]) {
            console.log("Received request to read table: " + query["table"]) ;
            readTable(request, response, query["table"], sql2json) ;
        } else {
            response.end("ERROR: Usage: /json/read?table=name"
                         + " (request: " + request.url + ")") ;
        }
        break ;
    }
}

function requestHandler(request, response) {
    var data = "" ;
    requestParts = url.parse(request.url, true) ;
    rootCall = requestParts["pathname"].split('/')[1] ;
    console.log("Recieved request for: " + rootCall) ;
    switch (rootCall) {
    case "env":
	      if (process.env) {
	          data += "<p>" ;
		        for (v in process.env) {
		            data += v + "=" + process.env[v] + "<br>\n" ;
		        }
		        data += "<br>\n" ;
	      } else {
		        data += "<p> No process env? <br>\n" ;
	      }
        response.end(data) ;
        break ;
    case "json":
        var method = requestParts["pathname"].split('/')[2] ;
        dispatchApi(request, response, method, requestParts["query"]) ;
        return(true) ;
        break ;
    case "dbstatus":
        data += dbConnectState ;
        response.end(data) ;
        break ;
    case "ping":
        if (dbConnectState) {
            doPing(request, response) ;
        } else {
            data += "I'm sorry, Dave, I can't do that. No connection to database." ;
            response.end(data) ;
        }
        break ;
    case "write":
        if (requestParts["query"]["key"]) {
            console.log("Received request to write key: " + requestParts["query"]["key"]) ;
            writeSomething(request, response, requestParts["query"]["key"]) ;
        } else {
            response.end("ERROR: Usage: /write?key=foo"
                         + "(request: " + request.url  + ")") ;
        }
        return(true) ;
        break ;
    case "":
        if ("mysql" == activateState) {
            readTable(request, response, "SampleData", handleValuesRequest) ;
        } else if ("riakcs" == activateState) {
            response.end("When using RiakCS, use the /json/read end-point to view data.") ;
        } else {
            response.end("Error: Not set up to use either MySQL or RiakCS as a backing store.") ;
        }
    }
}

// MAIN
var staticServer = serveStatic("static") ;
monitorServer = http.createServer(function(req, res) {
    if (! requestHandler(req, res)) {
        var done = finalhandler(req, res) ;
        staticServer(req, res, done)
    }
}) ;

if ("mysql" == activateState) {
    MySQLConnect() ;
} else if ("riakcs" != activateState) {
    console.error("Error: Not set up to use either MySQL or RiakCS as a backing store.") ;
}
    
monitorServer.listen(port) ;

console.log("Server up and listening on port: " + port) ;