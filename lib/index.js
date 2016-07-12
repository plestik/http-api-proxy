var http = require("http");
var https = require("https");
var path = require("path");
var url = require("url");
var fs = require("fs");

var connect = require("connect");
var httpProxy = require('http-proxy');
var rateLimit = require("rate-limit");
var connectResponseCache = require("connect-response-cache");
var mkdirp = require("mkdirp");
var basic = require("basic-authorization-header");

var hosts = require("./hosts");

exports.startServer = startServer;
exports.app = require("./app");

function startServer(sites, options) {
    var httpServer;
        
    var httpsServer;

    if (options.http) {
        httpServer = createServerForProtocol("http");
    }

    if (options.https) {
        httpsServer = createServerForProtocol("https");
    }
    
    function createServerForProtocol(protocolName) {
        var relevantSites = sites,
            protocolOptions = options[protocolName],
            port;

        if (typeof protocolOptions !== 'object') {
            protocolOptions = {
                port: protocolOptions
            };
        }

        port = protocolOptions.port;

        return createServer(relevantSites, protocolName, Object.assign({}, protocolOptions, options))
            .listen(port);
    }
    
    return {
        close: function() {

            if (httpServer) {
                httpServer.close();
            }
            if (httpsServer) {
                httpsServer.close();
            }
        }
    }
}

function isProtocol(protocol) {
    return function(site) {
        return protocol + ":" === site.upstream.protocol;
    };
}

function createServer(sites, protocol, options) {
    options = options || {};

    var isHttps = protocol === "https";
    
    var proxyQueues = new ProxyQueues(sites, options.defaultInterval);

    var proxyOptions = {};

    var headers = {};

    var proxy = new httpProxy.createServer(proxyOptions);

    var getSiteForRequest = function ( request ) {

        var host = request.headers.site || request.headers.host,
            name = request.headers.name;

        var site =
                sites.filter(function ( site ) {                    
                    return name ?
                        site.name === name
                        : site.upstream.hostname === host;
                })[0];


        return site;

    };
    
    var proxyMiddleware = function(request, response) {

        var host = request.headers.site || request.headers.host;

        request.headers.host = host;

        var site = getSiteForRequest(request);

        var localProtocol = (site ? site.upstream.protocol : protocol).replace(':', '');

        var requestHost = hosts.parseHost(localProtocol, host);

        var proxyQueue = proxyQueues.forHost(requestHost);

        if (proxyQueue) {

            var auth = site ? site.auth : null;
            var headers = site ? Object.assign({}, site.headers) : {};
            var host = requestHost.hostname;
            var port = requestHost.port ? ( ':' + requestHost.port) : '';

            var target = localProtocol + '://' + host + port;

            if (auth) {
                switch (auth.type) {
                    case 'basic':
                    headers.Authorization = basic(auth.username, auth.password);
                    break;
                }
            }

            proxyQueue.add(function() {

                request.resume();

                proxy.web(
                    request,
                    response,
                    {
                        target: target,
                        headers: headers,
                        secure: false
                    }
                );
            });
        } else {
            response.writeHead(500, {
                "Content-Type": "text/plain"
            });
            response.end("Proxy has not been configured for host: " + host);
        }
    };
    
    var app = connect();

    if (options.cors) {
        app.use(function ( request, response, next ) {

            response.setHeader('Access-Control-Allow-Origin', '*');
            response.setHeader('Access-Control-Request-Method', 'GET');

            if (request.method === 'OPTIONS' ) {

                response.setHeader('Access-Control-Allow-Methods', 'OPTIONS, GET');
                response.setHeader('Access-Control-Allow-Headers', request.headers['access-control-request-headers']);

                response.writeHead(200);
                response.end();
                return;
            }

            next();

        });
    }
    
    app.use(function(request, response, next) {
        request.pause();
        next();
    });
    
    if (options.cacheAge) {
        var cachePath = options.cachePath;
        if (options.cachePath) {
            var backendCachePath = path.join(cachePath, protocol + ".sqlite");
            mkdirp.sync(path.dirname(backendCachePath));
        }
        app.use(connectResponseCache({
            maxAge: options.cacheAge,
            cachePath: cachePath,
            backend: {
                path: backendCachePath
            }
        }));
    }
    
    app.use(proxyMiddleware);
    
    return isHttps ?
        https.createServer({
            key: fs.readFileSync(options.ssl.key),
            cert: fs.readFileSync(options.ssl.cert)
        }, app)
        : http.createServer(app);
}

function ProxyQueues(sites, defaultInterval) {
    this._defaultInterval = defaultInterval;
    var queues = this._queues = {};
    
    sites.forEach(function(site) {
        var host = new hosts.Host(site.upstream);
        queues[host.toString()] = rateLimit.createQueue({interval: site.interval});
    });
}

ProxyQueues.prototype.forHost = function(host) {
    var key = host.toString();
    if (!this._queues[key]) {
        if (this._defaultInterval || this._defaultInterval === 0) {
            this._queues[key] = rateLimit.createQueue({interval: this._defaultInterval});
        } else {
            return null;
        }
    }
    return this._queues[key];
};
