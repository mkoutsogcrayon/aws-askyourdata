import * as apigwv2 from "@aws-cdk/aws-apigatewayv2-alpha";
import * as cognitoIdentityPool from "@aws-cdk/aws-cognito-identitypool-alpha";
import * as cdk from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as cf from "aws-cdk-lib/aws-cloudfront";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as route53 from "aws-cdk-lib/aws-route53";
import { AwsCustomResource, AwsSdkCall, PhysicalResourceId } from "aws-cdk-lib/custom-resources";
import { IpTarget } from "aws-cdk-lib/aws-elasticloadbalancingv2-targets";
import { Construct } from "constructs";
import {
  ExecSyncOptionsWithBufferEncoding,
  execSync,
} from "node:child_process";
import * as path from "node:path";
import { Shared } from "../shared";
import { SystemConfig } from "../shared/types";
import { Utils } from "../shared/utils";
import { ChatBotApi } from "../chatbot-api";
import { NagSuppressions } from "cdk-nag";


export interface PrivateWebsiteProps {
  readonly config: SystemConfig;
  readonly shared: Shared;
  readonly userPoolId: string;
  readonly userPoolClientId: string;
  readonly identityPool: cognitoIdentityPool.IdentityPool;
  readonly api: ChatBotApi;
  readonly chatbotFilesBucket: s3.Bucket;
  readonly crossEncodersEnabled: boolean;
  readonly sagemakerEmbeddingsEnabled: boolean;
  readonly websiteBucket: s3.Bucket;
}

export class PrivateWebsite extends Construct {
  constructor(scope: Construct, id: string, props: PrivateWebsiteProps) {
    super(scope, id);

    // PRIVATE WEBSITE 
    // REQUIRES: 
    // 1. ACM Certificate ARN and Domain of website to be input during 'npm run create': 
    //    "privateWebsite" : true,
    //    "certificate" : "arn:aws:acm:ap-southeast-2:1234567890:certificate/XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXX",
    //    "domain" : "sub.example.com"
    // 2. In Route 53 link the VPC to the Private Hosted Zone (PHZ) (https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/hosted-zone-private-associate-vpcs.html)
    // 3. In the PHZ, add an "A Record" that points to the Application Load Balancer Alias (https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/routing-to-elb-load-balancer.html)

    // Retrieving S3 Endpoint Ips for ALB Target
    const s3EndpointId = props.shared.s3vpcEndpoint.vpcEndpointId
    const vpc = props.shared.vpc
    const vpcEndpointNetworkInterfaceIds = props.shared.s3vpcEndpoint.vpcEndpointNetworkInterfaceIds

    // First, retrieve the VPC Endpoint
    const vpcEndpointsCall: AwsSdkCall = {
        service: 'EC2',
        action: 'describeVpcEndpoints',
        parameters: {
            VpcEndpointIds: [s3EndpointId]
        },
        physicalResourceId: cdk.custom_resources.PhysicalResourceId.of('describeNetworkInterfaces'), //PhysicalResourceId.of('describeVpcEndpoints'), 
        outputPaths: ['VpcEndpoints.0.NetworkInterfaceIds']
    }

    const vpcEndpoints = new AwsCustomResource(
        this, 'describeVpcEndpoints', {
        onCreate: vpcEndpointsCall,
        onUpdate: vpcEndpointsCall,
        policy: {
            statements: [
                new iam.PolicyStatement({ 
                    actions: ["ec2:DescribeVpcEndpoints"],
                    resources: ["*"]
                })]
        }
    })

    // Then, retrieve the Private IP Addresses for each ENI of the VPC Endpoint
    let s3IPs: IpTarget[] = [];
    for (let index = 0; index < vpc.availabilityZones.length; index++) {
        
        const eniId = cdk.Fn.select(index, vpcEndpointNetworkInterfaceIds)
        
        const sdkCall: AwsSdkCall = {
            service: 'EC2',
            action: 'describeNetworkInterfaces',
            outputPaths: [`NetworkInterfaces.0.PrivateIpAddress`],
            parameters: {
                NetworkInterfaceIds: [vpcEndpoints.getResponseField(`VpcEndpoints.0.NetworkInterfaceIds.${index}`)],
                Filters: [
                    { Name: "interface-type", Values: ["vpc_endpoint"] }
                ],
            },
            physicalResourceId: cdk.custom_resources.PhysicalResourceId.of('describeNetworkInterfaces'), //PhysicalResourceId.of('describeNetworkInterfaces'),
        }

        const eni = new AwsCustomResource(
            this,
            `DescribeNetworkInterfaces-${index}`,
            {
                onCreate: sdkCall,
                onUpdate: sdkCall,
                policy: {
                    statements: [
                        new iam.PolicyStatement({ 
                            actions: ["ec2:DescribeNetworkInterfaces"],
                            resources: ["*"] //[`arn:aws:ec2:${process.env.CDK_DEFAULT_REGION }:${process.env.CDK_DEFAULT_ACCOUNT}:network-interface/${eniId}`]
                        }),
                    ],
                },
            }
        );

        s3IPs.push(new IpTarget(cdk.Token.asString(eni.getResponseField(`NetworkInterfaces.0.PrivateIpAddress`)), 443))
    }


    // Website ALB 
    const albSecurityGroup = new ec2.SecurityGroup(this, 'WebsiteApplicationLoadBalancerSG', {
            vpc: props.shared.vpc,
            allowAllOutbound: false
        });

    albSecurityGroup.addIngressRule(
        ec2.Peer.anyIpv4(),
        ec2.Port.tcp(443)
    );

    albSecurityGroup.addIngressRule(
        ec2.Peer.anyIpv4(),
        ec2.Port.tcp(80)
    );

    albSecurityGroup.addEgressRule(
        ec2.Peer.ipv4(props.shared.vpc.vpcCidrBlock),
        ec2.Port.tcp(443)
    );

    const loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'ALB', {
        vpc: props.shared.vpc,
        internetFacing: false,
        securityGroup: albSecurityGroup,
        vpcSubnets: props.shared.vpc.selectSubnets({
            subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS
          }),
    });

    const albLogBucket = new s3.Bucket(this, 'ALBLoggingBucket', {

        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        autoDeleteObjects: true,
        enforceSSL: true,

    });
    loadBalancer.logAccessLogs(albLogBucket)

    // Adding Listener
    // Using ACM certificate ARN passed in through props/config file 
    if (props.config.certificate) {
        const albListener = loadBalancer.addListener('ALBLHTTPS',
        {
            protocol: elbv2.ApplicationProtocol.HTTPS,
            port: 443,
            certificates: [elbv2.ListenerCertificate.fromArn(props.config.certificate)],
            sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS
        });
          
        // Add ALB targets
        albListener.addTargets('s3TargetGroup',
            {
                port: 443,
                protocol: elbv2.ApplicationProtocol.HTTPS,
                targets: s3IPs,
                healthCheck: {
                    protocol: elbv2.Protocol.HTTPS,
                    path: '/',
                    healthyHttpCodes: '307,405'
                }
            });
            
        // The Amazon S3 PrivateLink Endpoint is a REST API Endpoint, which means that trailing slash requests will return XML directory listings by default.
        // To work around this, you’ll create a redirect rule to point all requests ending in a trailing slash to index.html.
        albListener.addAction('privateLinkRedirectPath', {
            priority: 1,
            conditions: [
              elbv2.ListenerCondition.pathPatterns(['/']),
            ],
            action: elbv2.ListenerAction.redirect({
              port: '#{port}',
              path: '/index.html', //'/#{path}index.html' //
            })
        });
    }

    // Allow access to website bucket from S3 Endpoints
    props.websiteBucket.policy?.document.addStatements(
        new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['s3:GetObject', "s3:List*"],
            principals: [new iam.AnyPrincipal()],
            resources: [props.websiteBucket.bucketArn, `${props.websiteBucket.bucketArn}/*`],
            conditions: {
                "StringEquals": { "aws:SourceVpce": s3EndpointId }
            }
        })
    );

    // ###################################################
    // Outputs
    // ###################################################
    new cdk.CfnOutput(this, "Domain", {
      value: `https://${props.config.domain}`,
    });
    
    new cdk.CfnOutput(this, "LoadBalancerDNS", {
      value: loadBalancer.loadBalancerDnsName,
    });
    
    NagSuppressions.addResourceSuppressions(
      albSecurityGroup, 
      [
        {
          id: "AwsSolutions-EC23",
          reason: "Website Application Load Balancer can be open to 0.0.0.0/0 on ports 80 & 443.",
        },
      ]
    );
    
    NagSuppressions.addResourceSuppressions(
      props.websiteBucket, 
      [
        {
          id: "AwsSolutions-S5",
          reason: "Bucket has conditions to only allow access from S3 VPC Endpoints.",
        },
      ]
    );
    
    NagSuppressions.addResourceSuppressions(
      albLogBucket, 
      [
        {
          id: "AwsSolutions-S1",
          reason: "Bucket is the server access logs bucket for ALB.",
        },
      ]
    );
    
    
    
  }
}